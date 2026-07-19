// 让本网关同时支持 Anthropic 官方的 Messages API 格式（POST /v1/messages），
// 这样 Claude Code 等原生使用 Anthropic 协议的工具也可以直接把
// ANTHROPIC_BASE_URL 指向本项目使用。
//
// 思路：把 Anthropic 请求体转换成 OpenAI chat-completions 格式，复用
// proxy.js 里的 runProviderChain 故障转移逻辑，再把上游（OpenAI 格式）响应
// 转换回 Anthropic 的响应 / SSE 事件格式返回给客户端。

import { runProviderChain } from "./proxy.js";
import { json } from "./utils.js";

export function anthropicError(message, status = 400, type = "api_error") {
  return json({ type: "error", error: { type, message } }, status);
}

// ---- 请求转换：Anthropic Messages -> OpenAI chat-completions ----

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c.text || (typeof c.content === "string" ? c.content : "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertAnthropicMessage(m) {
  const role = m.role === "assistant" ? "assistant" : "user";
  if (typeof m.content === "string") {
    return [{ role, content: m.content }];
  }
  const blocks = Array.isArray(m.content) ? m.content : [];
  const out = [];
  let textParts = [];
  let imageParts = [];
  let toolCalls = [];

  const flush = () => {
    if (!textParts.length && !imageParts.length && !toolCalls.length) return;
    const msg = { role };
    if (imageParts.length) {
      const parts = [];
      const joinedText = textParts.join("\n");
      if (joinedText) parts.push({ type: "text", text: joinedText });
      parts.push(...imageParts);
      msg.content = parts;
    } else if (textParts.length) {
      msg.content = textParts.join("\n");
    } else {
      msg.content = null;
    }
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
    textParts = [];
    imageParts = [];
    toolCalls = [];
  };

  for (const b of blocks) {
    if (b.type === "text") {
      textParts.push(b.text || "");
    } else if (b.type === "image") {
      const src = b.source || {};
      if (src.type === "base64") {
        imageParts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
      } else if (src.type === "url" && src.url) {
        imageParts.push({ type: "image_url", image_url: { url: src.url } });
      }
    } else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      });
    } else if (b.type === "tool_result") {
      flush();
      out.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: extractTextFromContent(b.content) || "",
      });
    }
  }
  flush();
  return out.length ? out : [{ role, content: "" }];
}

function anthropicToolToOpenAI(t) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  };
}

function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return "auto";
}

export function anthropicRequestToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sysText = Array.isArray(body.system)
      ? body.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
      : body.system;
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  for (const m of body.messages || []) {
    messages.push(...convertAnthropicMessage(m));
  }

  const openaiBody = {
    model: body.model,
    messages,
    stream: !!body.stream,
  };
  if (body.max_tokens != null) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) openaiBody.temperature = body.temperature;
  if (body.top_p != null) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    openaiBody.tools = body.tools.map(anthropicToolToOpenAI);
  }
  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (toolChoice !== undefined) openaiBody.tool_choice = toolChoice;

  return openaiBody;
}

// ---- 非流式响应转换：OpenAI chat-completions -> Anthropic Message ----

const FINISH_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "end_turn",
};

export function openAIResponseToAnthropic(data, fallbackModel) {
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === "string" && msg.content.length) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${crypto.randomUUID()}`,
        name: tc.function?.name || "",
        input,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = data.usage || {};
  return {
    id: data.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: data.model || fallbackModel,
    content,
    stop_reason: FINISH_REASON_MAP[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// ---- 流式响应转换：OpenAI SSE -> Anthropic SSE 事件流 ----

export function createAnthropicSSEStream(openaiResponse, fallbackModel) {
  const reader = openaiResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const messageId = `msg_${crypto.randomUUID()}`;

  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      let nextBlockIndex = 0;
      let textBlockIndex = null;
      const toolBlocks = new Map(); // openai tool-call index -> { anthropicIndex, id }
      let finishReason = null;
      const usage = { input_tokens: 0, output_tokens: 0 };

      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: fallbackModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      });

      const ensureTextBlock = () => {
        if (textBlockIndex === null) {
          textBlockIndex = nextBlockIndex++;
          send("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
        }
        return textBlockIndex;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop();
          for (const chunk of chunks) {
            for (const line of chunk.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const dataStr = trimmed.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") continue;
              let evt;
              try {
                evt = JSON.parse(dataStr);
              } catch {
                continue;
              }
              if (evt.usage) {
                usage.input_tokens = evt.usage.prompt_tokens ?? usage.input_tokens;
                usage.output_tokens = evt.usage.completion_tokens ?? usage.output_tokens;
              }
              const choice = (evt.choices && evt.choices[0]) || {};
              const delta = choice.delta || {};
              if (delta.content) {
                const idx = ensureTextBlock();
                send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: delta.content } });
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const key = tc.index ?? 0;
                  let entry = toolBlocks.get(key);
                  if (!entry) {
                    const idx = nextBlockIndex++;
                    entry = { anthropicIndex: idx, id: tc.id || `toolu_${crypto.randomUUID()}` };
                    toolBlocks.set(key, entry);
                    send("content_block_start", {
                      type: "content_block_start",
                      index: idx,
                      content_block: { type: "tool_use", id: entry.id, name: tc.function?.name || "", input: {} },
                    });
                  }
                  if (tc.function?.arguments) {
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: entry.anthropicIndex,
                      delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                    });
                  }
                }
              }
              if (choice.finish_reason) finishReason = choice.finish_reason;
            }
          }
        }
      } catch {
        // 上游连接中断，跳出循环并尝试正常收尾，让客户端至少拿到已生成的内容
      }

      if (textBlockIndex !== null) {
        send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
      }
      for (const entry of toolBlocks.values()) {
        send("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex });
      }
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: FINISH_REASON_MAP[finishReason] || "end_turn", stop_sequence: null },
        usage,
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}

// 主入口：POST /v1/messages（Anthropic 格式）
export async function handleAnthropicMessages(request, env) {
  let anthropicBody;
  try {
    anthropicBody = await request.json();
  } catch {
    return anthropicError("Request body must be valid JSON", 400, "invalid_request_error");
  }

  const openaiBody = anthropicRequestToOpenAI(anthropicBody);
  const result = await runProviderChain(env, openaiBody);

  if (!result.ok) {
    if (result.upstreamResp) {
      const text = await result.upstreamResp.text().catch(() => "");
      return anthropicError(`Upstream error: ${text.slice(0, 400)}`, result.upstreamResp.status, "api_error");
    }
    return anthropicError(result.message, result.status, result.code === "no_provider_available" ? "invalid_request_error" : "api_error");
  }

  const modelId = result.model.id;

  if (openaiBody.stream) {
    const stream = createAnthropicSSEStream(result.resp, modelId);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "X-Upstream-Provider": result.provider.name,
        "X-Upstream-Model": modelId,
      },
    });
  }

  const data = await result.resp.json();
  const anthropicJson = openAIResponseToAnthropic(data, modelId);
  return json(anthropicJson, 200, {
    "X-Upstream-Provider": result.provider.name,
    "X-Upstream-Model": modelId,
  });
}
