// 转发核心。

import { joinUrl, buildAuthHeaders } from './presets.js';
import { buildCandidates, providerOf, markFailure, clearFailure, getCooldown } from './chain.js';
import { jsonResponse, apiError, CORS_HEADERS } from './http.js';
import { recordUsage, meterBody, estimateTokens, estimateFromCounts } from './usage.js';

// 内存级统计，仅用于面板展示，不写 KV。
export const runtimeStats = {
  startedAt: Date.now(),
  requests: 0,
  success: 0,
  failed: 0,
  byModel: Object.create(null),
};

function note(modelId, ok) {
  const rec = (runtimeStats.byModel[modelId] = runtimeStats.byModel[modelId] || { ok: 0, fail: 0 });
  if (ok) rec.ok += 1;
  else rec.fail += 1;
}

const HOP_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

function passThroughHeaders(upstream) {
  const headers = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return headers;
}

// 把 SSE 流里的 "model":"上游名" 换回客户端请求的名字。
// 按行切分处理，避免关键字被切在两个 chunk 中间；不做 JSON 解析，CPU 开销极低。
function rewriteStream(readable, from, to) {
  if (!from || !to || from === to) return readable;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const pairs = [
    ['"model":"' + from + '"', '"model":"' + to + '"'],
    ['"model": "' + from + '"', '"model": "' + to + '"'],
  ];
  let buf = '';
  const swap = (s) => {
    for (const [a, b] of pairs) if (s.includes(a)) s = s.split(a).join(b);
    return s;
  };
  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true });
        const idx = buf.lastIndexOf('\n');
        if (idx === -1) return;
        const out = swap(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
        controller.enqueue(enc.encode(out));
      },
      flush(controller) {
        const tail = buf + dec.decode();
        if (tail) controller.enqueue(enc.encode(swap(tail)));
      },
    })
  );
}

/**
 * 把一次调用记进用量统计。
 * 上游给了 usage 就用真值；没给就按字符数估算，并标记成 estimated。
 */
export function accountCall({ config, auth, model, endpoint, body, usage, outChars, outCjk, ok = true }) {
  if (!auth || !auth.id) return;
  if (config && config.settings && config.settings.trackUsage === false) return;

  if (!ok) {
    recordUsage({ keyId: auth.id, name: auth.name, model: model && model.alias, endpoint, prompt: 0, completion: 0 });
    return;
  }
  if (usage) {
    recordUsage({
      keyId: auth.id,
      name: auth.name,
      model: model && model.alias,
      endpoint,
      prompt: usage.prompt,
      completion: usage.completion,
    });
    return;
  }
  recordUsage({
    keyId: auth.id,
    name: auth.name,
    model: model && model.alias,
    endpoint,
    prompt: estimateTokens(promptTextOf(body)),
    completion: estimateFromCounts(outChars, outCjk),
    estimated: true,
  });
}

function promptTextOf(body) {
  if (!body) return '';
  if (Array.isArray(body.messages)) return JSON.stringify(body.messages);
  if (typeof body.prompt === 'string') return body.prompt;
  if (body.input != null) return typeof body.input === 'string' ? body.input : JSON.stringify(body.input);
  return '';
}

// 新版 OpenAI SDK 会把 system 提示发成 role:"developer"。
// 除了 OpenAI 自己，几乎没有哪家兼容接口认这个角色 —— MiniMax 直接 400。
// 映射成 system 语义上不丢东西（developer 本来就是 system 的新叫法），
// 真想原样透传就在设置页关掉。
function mapDeveloperRole(messages) {
  if (!Array.isArray(messages)) return messages;
  let touched = false;
  const out = messages.map((m) => {
    if (m && m.role === 'developer') {
      touched = true;
      return { ...m, role: 'system' };
    }
    return m;
  });
  return touched ? out : messages;
}

function applyModelOverrides(body, model, settings) {
  const out = { ...body, model: model.model };
  if (settings && settings.mapDeveloperRole !== false && Array.isArray(out.messages)) {
    out.messages = mapDeveloperRole(out.messages);
  }
  if (Array.isArray(model.dropParams)) {
    for (const p of model.dropParams) delete out[p];
  }
  if (model.paramOverrides && typeof model.paramOverrides === 'object') {
    Object.assign(out, model.paramOverrides);
  }
  return out;
}

/**
 * 有些上游会返回 HTTP 200，但真正的错误藏在 SSE 流的第一个事件里。
 * 只看状态码会误判成功，客户端收到一坨错误还以为是模型的锅。
 * 这里把第一块读出来看一眼，再原样接回流里 —— 不丢数据、不加延迟。
 */
async function peekStream(res, waitMs) {
  const reader = res.body.getReader();
  const first = reader.read();
  let settled = null;
  if (waitMs > 0) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    settled = await Promise.race([first, timeout]);
    clearTimeout(timer);
  }

  let usedFirst = false;
  const body = new ReadableStream({
    async pull(controller) {
      const r = usedFirst ? await reader.read() : ((usedFirst = true), await first);
      if (r.done) { controller.close(); return; }
      controller.enqueue(r.value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });

  // 首块没在预算内到达（推理模型首 token 慢是常事）就别judge，直接放行
  let head = '';
  if (settled && settled.value) {
    try { head = new TextDecoder().decode(settled.value); } catch { head = ''; }
  }
  return { body, head };
}

/** 首块里能看出是错误就返回错误文案，否则返回空串。 */
function streamErrorIn(head) {
  const s = String(head || '').trim();
  if (!s) return '';
  const pick = (o) => {
    if (!o || typeof o !== 'object' || !o.error) return '';
    const e = o.error;
    return String((e && (e.message || e.msg)) || e).slice(0, 300);
  };
  // 有的上游干脆不发 SSE，直接吐一个 JSON 错误体
  if (s.startsWith('{')) {
    try { const hit = pick(JSON.parse(s)); if (hit) return hit; } catch { /* 不是完整 JSON，继续按 SSE 扫 */ }
  }
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { const hit = pick(JSON.parse(payload)); if (hit) return hit; } catch { /* 不完整的块，跳过 */ }
  }
  return '';
}

async function forwardOnce({ provider, model, path, body, headerTimeoutMs, settings }) {
  const url = joinUrl(provider.baseUrl, path);
  const controller = new AbortController();
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) controller.abort();
  }, headerTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
        ...buildAuthHeaders(provider),
      },
      body: JSON.stringify(applyModelOverrides(body, model, settings)),
      signal: controller.signal,
    });
    // 收到响应头就解除超时，否则流式回答会被中途掐断。
    settled = true;
    clearTimeout(timer);
    return { res };
  } catch (err) {
    settled = true;
    clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      error: aborted ? '等待响应头超时（' + headerTimeoutMs + 'ms）' : String((err && err.message) || err),
    };
  }
}

/**
 * 按链路顺序尝试，命中即返回上游的原始 Response，绝不回头再试。
 * OpenAI 路由和 Anthropic 桥接层共用这一段。
 */
export async function runChain({ env, config, body, path, embedding = false }) {
  const { list, matched, unknownModel } = buildCandidates(config, body.model, { embedding });
  const settings = config.settings;
  runtimeStats.requests += 1;

  if (!list.length) {
    runtimeStats.failed += 1;
    return { ok: false, reason: 'no_models', attempts: [] };
  }

  const attempts = [];

  for (const model of list) {
    const provider = providerOf(config, model);
    if (!provider || provider.enabled === false || !provider.baseUrl) {
      attempts.push({ model: model.alias, status: 0, error: '提供商缺失或已停用' });
      continue;
    }

    const cd = getCooldown(model.id);
    const started = Date.now();
    const { res, error } = await forwardOnce({
      provider,
      model,
      path,
      body,
      headerTimeoutMs: Math.max(3000, Number(settings.headerTimeoutMs) || 25000),
      settings,
    });

    if (error) {
      markFailure(model.id, settings.cooldownSeconds, 0, error);
      note(model.id, false);
      attempts.push({ model: model.alias, provider: provider.name, status: 0, error, ms: Date.now() - started });
      continue;
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        detail = '';
      }
      markFailure(model.id, settings.cooldownSeconds, res.status, detail);
      note(model.id, false);
      attempts.push({
        model: model.alias,
        provider: provider.name,
        status: res.status,
        error: detail || res.statusText,
        ms: Date.now() - started,
      });
      continue;
    }

    // 状态码是 200，但流式响应里可能藏着错误。看一眼首块再决定。
    if (body.stream && res.body && settings.peekStreamErrors !== false) {
      const budget = Math.max(1500, Math.min(Number(settings.headerTimeoutMs) || 25000, 20000));
      const peeked = await peekStream(res, budget);
      const streamErr = streamErrorIn(peeked.head);
      if (streamErr) {
        markFailure(model.id, settings.cooldownSeconds, res.status, streamErr);
        note(model.id, false);
        attempts.push({
          model: model.alias, provider: provider.name, status: res.status,
          error: '流内错误：' + streamErr, ms: Date.now() - started,
        });
        continue;
      }
      clearFailure(model.id);
      note(model.id, true);
      runtimeStats.success += 1;
      return {
        ok: true, res, body: peeked.body, model, provider, attempts, matched, recovered: Boolean(cd),
      };
    }

    // ---- 命中，收工 ----
    clearFailure(model.id);
    note(model.id, true);
    runtimeStats.success += 1;
    return { ok: true, res, body: res.body, model, provider, attempts, matched, recovered: Boolean(cd) };
  }

  // 全链路阵亡。
  runtimeStats.failed += 1;
  return { ok: false, reason: 'all_failed', attempts, unknownModel, asked: body.model };
}

export function chainFailureResponse(result) {
  if (result.reason === 'no_models') {
    return apiError(
      403,
      '网关里没有任何可用模型。请先在 /admin 添加提供商并把模型加入调用链。',
      'no_models_configured',
      'no_models'
    );
  }
  const hint = result.unknownModel
    ? '客户端请求的模型「' + result.asked + '」不在网关列表中，已按默认顺序尝试全部模型。'
    : '';
  return apiError(
    403,
    '所有已配置的模型都调用失败。' + hint + ' 详见 details。',
    'all_upstreams_failed',
    'all_failed',
    result.attempts
  );
}

export function gatewayHeaders(result, requestId) {
  const headers = passThroughHeaders(result.res);
  headers.set('X-Gateway-Model', result.model.alias);
  headers.set('X-Gateway-Upstream-Model', result.model.model);
  headers.set('X-Gateway-Provider', result.provider.name);
  headers.set('X-Gateway-Attempts', String(result.attempts.length + 1));
  if (result.recovered) headers.set('X-Gateway-Recovered', '1');
  if (requestId) headers.set('X-Gateway-Request-Id', requestId);
  return headers;
}

/** OpenAI 协议入口：命中后按需回写 model 字段再原样吐出去。 */
export async function proxyOpenAI({ env, config, path, body, requestId, embedding = false, auth = null }) {
  const result = await runChain({ env, config, body, path, embedding });
  const endpoint = embedding ? 'embeddings' : path === 'completions' ? 'completions' : 'chat';

  if (!result.ok) {
    accountCall({ config, auth, endpoint, body, ok: false });
    return chainFailureResponse(result);
  }

  const { res, model, matched } = result;
  const headers = gatewayHeaders(result, requestId);
  const wantRewrite = config.settings.rewriteModelName !== false;
  const clientName = matched ? model.alias : body.model || model.alias;
  const track = Boolean(auth && auth.id) && config.settings.trackUsage !== false;
  const meter = (readable, stream) =>
    track
      ? meterBody(readable, {
          stream,
          onDone: ({ usage, outChars, outCjk }) =>
            accountCall({ config, auth, model, endpoint, body, usage, outChars, outCjk }),
        })
      : readable;

  const upstreamBody = result.body || res.body;
  if (body.stream) {
    const rewritten = wantRewrite ? rewriteStream(upstreamBody, model.model, clientName) : upstreamBody;
    return new Response(meter(rewritten, true), { status: res.status, headers });
  }
  if (!wantRewrite || model.model === clientName) {
    return new Response(meter(upstreamBody, false), { status: res.status, headers });
  }
  const text = await res.text();
  try {
    const payload = JSON.parse(text);
    if (track) {
      const len = contentLenOf(payload);
      accountCall({ config, auth, model, endpoint, body, usage: usageOf(payload), outChars: len.chars, outCjk: len.cjk });
    }
    if (payload && typeof payload === 'object') payload.model = clientName;
    return new Response(JSON.stringify(payload), { status: res.status, headers });
  } catch {
    return new Response(text, { status: res.status, headers });
  }
}

function usageOf(payload) {
  const u = payload && payload.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.prompt_tokens || u.input_tokens || 0) || 0;
  const completion = Number(u.completion_tokens || u.output_tokens || 0) || 0;
  if (!prompt && !completion) return null;
  return { prompt, completion };
}

function contentLenOf(payload) {
  let text = '';
  const choices = payload && payload.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const msg = (c && c.message) || {};
      if (typeof msg.content === 'string') text += msg.content;
      if (typeof msg.reasoning_content === 'string') text += msg.reasoning_content;
    }
  }
  const m = text.match(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/g);
  return { chars: text.length, cjk: m ? m.length : 0 };
}

export function buildModelList(config, { includeOwner = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = config.models
    .filter((m) => m.enabled !== false)
    .map((m) => {
      const provider = providerOf(config, m);
      const entry = {
        id: m.alias,
        object: 'model',
        created: Math.floor((m.createdAt || Date.now()) / 1000) || now,
        owned_by: includeOwner ? (provider ? provider.name : 'gateway') : 'gateway',
      };
      // 非标准字段，但对手动排查很有用，且不影响标准客户端解析。
      entry.gateway = {
        upstream_model: m.model,
        provider: provider ? provider.name : null,
        kind: m.kind || 'chat',
        capabilities: m.caps || {},
        is_default: config.defaultModel === m.id,
      };
      return entry;
    });
  return { object: 'list', data };
}
