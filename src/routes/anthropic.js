// Anthropic Messages 协议桥接（POST /v1/messages）。
//
// 为什么需要它：Claude Code 说的是 Anthropic 的协议，不是 OpenAI 的。
// 网关内部统一走 OpenAI 格式，这一层负责进来时翻成 OpenAI、出去时翻回 Anthropic，
// 中间复用同一条故障转移链。
//
// 覆盖范围：文本、图片输入、system、tools / tool_use / tool_result、流式。
// 不覆盖：extended thinking、citations、文档块、prompt caching —— 这些没有 OpenAI 对应物。

import { jsonResponse, apiError, readJsonBody } from '../lib/http.js';
import { verifyGatewayKey, checkKeyRate } from '../lib/auth.js';
import { loadConfig, loadKeys } from '../lib/config.js';
import { runChain, chainFailureResponse, gatewayHeaders, accountCall } from '../lib/proxy.js';
import { randomToken } from '../lib/crypto.js';
import { recordUsage, maybeFlushUsage, meterBody, estimateTokens, countCjk } from '../lib/usage.js';

const ANTHROPIC_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

export function isAnthropicPath(pathname) {
  return ANTHROPIC_PATHS.has(pathname);
}

// ---------- 入向：Anthropic -> OpenAI ----------

function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
  }
  return '';
}

function convertContent(content) {
  // 返回 { parts, toolCalls, toolResults }
  if (typeof content === 'string') return { parts: [{ type: 'text', text: content }], toolCalls: [], toolResults: [] };
  const parts = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'image' && block.source) {
      const src = block.source;
      const url =
        src.type === 'base64'
          ? 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data
          : src.url || '';
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input == null ? {} : block.input) },
      });
    } else if (block.type === 'tool_result') {
      const c = block.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((x) => (x && x.type === 'text' ? x.text : '')).filter(Boolean).join('\n')
            : JSON.stringify(c == null ? '' : c);
      toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
    }
  }
  return { parts, toolCalls, toolResults };
}

export function anthropicToOpenAI(body) {
  const messages = [];
  const sys = flattenSystem(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const { parts, toolCalls, toolResults } = convertContent(msg.content);
    // tool_result 在 Anthropic 里放在 user 消息里，OpenAI 要求独立的 tool 消息，先发出去。
    for (const tr of toolResults) messages.push(tr);

    const onlyText = parts.length === 1 && parts[0].type === 'text';
    const content = parts.length === 0 ? null : onlyText ? parts[0].text : parts;

    if (msg.role === 'assistant') {
      const out = { role: 'assistant', content: content == null ? '' : content };
      if (toolCalls.length) out.tool_calls = toolCalls;
      if (content != null || toolCalls.length) messages.push(out);
    } else if (content != null) {
      messages.push({ role: 'user', content });
    }
  }

  const out = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens,
  };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
      }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'none') out.tool_choice = 'none';
      else out.tool_choice = 'auto';
    }
  }
  return out;
}

// ---------- 出向：OpenAI -> Anthropic ----------

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function mapStop(reason) {
  return STOP_MAP[reason] || 'end_turn';
}

export function openAIToAnthropic(payload, modelName) {
  const choice = (payload.choices && payload.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function && tc.function.arguments ? tc.function.arguments : '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || 'toolu_' + randomToken(16), name: tc.function ? tc.function.name : '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = payload.usage || {};
  return {
    id: payload.id || 'msg_' + randomToken(20),
    type: 'message',
    role: 'assistant',
    model: modelName,
    content,
    stop_reason: mapStop(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function sseEvent(type, data) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

/** 把 OpenAI 的 SSE 增量流转换成 Anthropic 的事件流。 */
export function streamOpenAIToAnthropic(readable, modelName) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  let started = false;
  let textOpen = false;
  let nextIndex = 0;
  const toolBlocks = new Map(); // openai tool index -> anthropic block index
  let stopReason = 'end_turn';
  let outputTokens = 0;
  let inputTokens = 0;
  let midStreamError = ''; // 上游中途吐 {"error":...} 时记下来，流尾用 Anthropic 的 error 事件收场
  const messageId = 'msg_' + randomToken(20);

  function start(controller) {
    if (started) return;
    started = true;
    controller.enqueue(
      enc.encode(
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })
      )
    );
  }

  function handleChunk(json, controller) {
    // 网关的 streamTailError 只在没有 [DONE] 时补发合成错误；这里再兜一层：
    // 只要事件里有 error 字段（无论上游原发还是网关合成），按 Anthropic 协议发
    // event: error 终止，而不是装作正常 message_stop 把残缺回答当完整回答交出去。
    if (json.error && !Array.isArray(json.choices)) {
      const e = json.error;
      midStreamError = String((e && (e.message || e.msg)) || (typeof e === 'string' ? e : '')) || '上游流中途出错。';
      return;
    }
    if (json.usage) {
      inputTokens = json.usage.prompt_tokens || inputTokens;
      outputTokens = json.usage.completion_tokens || outputTokens;
    }
    const choice = (json.choices && json.choices[0]) || {};
    const delta = choice.delta || {};

    if (delta.content) {
      if (!textOpen) {
        textOpen = true;
        controller.enqueue(enc.encode(sseEvent('content_block_start', {
          type: 'content_block_start', index: nextIndex, content_block: { type: 'text', text: '' },
        })));
      }
      controller.enqueue(enc.encode(sseEvent('content_block_delta', {
        type: 'content_block_delta', index: nextIndex, delta: { type: 'text_delta', text: String(delta.content) },
      })));
    }

    for (const tc of delta.tool_calls || []) {
      const oaIdx = typeof tc.index === 'number' ? tc.index : 0;
      if (!toolBlocks.has(oaIdx)) {
        if (textOpen) {
          controller.enqueue(enc.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: nextIndex })));
          textOpen = false;
          nextIndex += 1;
        }
        const blockIndex = nextIndex;
        toolBlocks.set(oaIdx, blockIndex);
        nextIndex += 1;
        controller.enqueue(enc.encode(sseEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: tc.id || 'toolu_' + randomToken(16), name: (tc.function && tc.function.name) || '', input: {} },
        })));
      }
      const args = tc.function && tc.function.arguments;
      if (args) {
        controller.enqueue(enc.encode(sseEvent('content_block_delta', {
          type: 'content_block_delta', index: toolBlocks.get(oaIdx), delta: { type: 'input_json_delta', partial_json: args },
        })));
      }
    }

    if (choice.finish_reason) stopReason = mapStop(choice.finish_reason);
  }

  function finish(controller) {
    if (!started) start(controller);
    if (midStreamError) {
      // Anthropic 流式协议允许用 event: error 终止流；客户端 SDK 会抛出而不是返回残文。
      controller.enqueue(
        enc.encode(
          sseEvent('error', { type: 'error', error: { type: 'api_error', message: midStreamError } })
        )
      );
      return;
    }
    if (textOpen) {
      controller.enqueue(enc.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: nextIndex })));
      textOpen = false;
    }
    for (const blockIndex of toolBlocks.values()) {
      controller.enqueue(enc.encode(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })));
    }
    controller.enqueue(enc.encode(sseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens },
    })));
    controller.enqueue(enc.encode(sseEvent('message_stop', { type: 'message_stop' })));
  }

  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let json;
          try { json = JSON.parse(payload); } catch { continue; }
          start(controller);
          handleChunk(json, controller);
        }
      },
      flush(controller) {
        finish(controller);
      },
    })
  );
}

// ---------- 路由 ----------

export async function handleAnthropic(request, env, ctx, url) {
  if (request.method !== 'POST') return apiError(405, '该接口只接受 POST。');

  const keys = await loadKeys(env);
  if (!keys.length) return apiError(403, '网关还没有创建任何 API 密钥。', 'no_api_keys', 'no_keys');
  const auth = await verifyGatewayKey(request, env);
  if (!auth.ok) {
    return jsonResponse(
      { type: 'error', error: { type: 'authentication_error', message: 'API 密钥无效或缺失。' } },
      { status: 401 }
    );
  }

  let body;
  try { body = await readJsonBody(request); }
  catch (err) { return apiError(400, err.message || '请求体解析失败。'); }

  // Claude Code 会先问 token 数。上游没有统一的计数接口，这里自己估。
  // 「用量」页在上游不返回 usage 时用的也是这个 estimateTokens，两处口径一致。
  if (url.pathname === '/v1/messages/count_tokens') {
    const text = JSON.stringify(body.messages || []) + flattenSystem(body.system);
    const inputTokens = estimateTokens(text);
    const cfgForCount = await loadConfig(env);
    if (cfgForCount.settings.trackUsage !== false) {
      recordUsage({
        keyId: auth.key.id,
        name: auth.key.name,
        endpoint: 'count_tokens',
        model: body.model,
        prompt: inputTokens,
        estimated: true,
      });
    }
    return jsonResponse({ input_tokens: inputTokens });
  }

  const config = await loadConfig(env);
  maybeFlushUsage(env, ctx, config.settings);
  const rate = checkKeyRate(auth.key.id, config.settings.keyRpmLimit);
  if (!rate.ok) {
    return jsonResponse(
      { type: 'error', error: { type: 'rate_limit_error', message: '这把密钥触发了每分钟请求数上限，请稍后再试。' } },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } }
    );
  }
  const openaiBody = anthropicToOpenAI(body);
  const acct = { id: auth.key.id, name: auth.key.name };
  const result = await runChain({ env, config, body: openaiBody, path: 'chat/completions' });
  if (!result.ok) {
    accountCall({ config, auth: acct, endpoint: 'messages', body: openaiBody, ok: false });
    const failure = chainFailureResponse(result);
    const detail = await failure.json();
    return jsonResponse(
      { type: 'error', error: { type: 'api_error', message: detail.error.message, details: detail.error.details } },
      { status: failure.status }
    );
  }

  const headers = gatewayHeaders(result, 'gw_' + randomToken(16));
  const clientName = body.model || result.model.alias;

  const track = config.settings.trackUsage !== false;

  if (openaiBody.stream) {
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('Cache-Control', 'no-cache');
    // 计量挂在上游那一侧（还是 OpenAI 格式），翻译成 Anthropic 事件之前就把数字数完
    const upstream = track
      ? meterBody(result.body || result.res.body, {
          stream: true,
          onDone: ({ usage, outChars, outCjk }) =>
            accountCall({
              config, auth: acct, model: result.model, endpoint: 'messages',
              body: openaiBody, usage, outChars, outCjk,
            }),
        })
      : (result.body || result.res.body);
    return new Response(streamOpenAIToAnthropic(upstream, clientName), { status: 200, headers });
  }

  const text = await result.res.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { return apiError(502, '上游返回的不是合法 JSON。', 'api_error'); }
  if (track) {
    const u = payload && payload.usage;
    // 上游没给 usage 时，用回复正文的字数估算，口径和 count_tokens 一致
    let out = '';
    for (const c of (payload && payload.choices) || []) {
      const msg = (c && c.message) || {};
      if (typeof msg.content === 'string') out += msg.content;
      if (typeof msg.reasoning_content === 'string') out += msg.reasoning_content;
    }
    accountCall({
      config, auth: acct, model: result.model, endpoint: 'messages', body: openaiBody,
      usage: u ? { prompt: Number(u.prompt_tokens) || 0, completion: Number(u.completion_tokens) || 0 } : null,
      outChars: out.length, outCjk: countCjk(out),
    });
  }
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(openAIToAnthropic(payload, clientName)), { status: 200, headers });
}
