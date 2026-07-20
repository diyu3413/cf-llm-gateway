// src/lib/utils.js
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta"
};
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}
function errorResponse(message, status = 400, code = "invalid_request_error") {
  return json(
    {
      error: {
        message,
        type: code,
        code: status
      }
    },
    status
  );
}
function uuid() {
  return crypto.randomUUID();
}
async function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `sk-cfg-${hex}`;
  const hash = await sha256Hex(key);
  return { key, hash, prefix: key.slice(0, 12) };
}
async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function slugify(name) {
  return (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "provider";
}
function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 3e4) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}
function guessCapabilities(modelId = "") {
  const id = modelId.toLowerCase();
  const vision = /(vision|4o|gpt-4o|gemini|vl|-v\b|image)/.test(id);
  const audio = /(audio|realtime|whisper|voice)/.test(id);
  const video = /(video|sora)/.test(id);
  const tools = !/(embedding|whisper|tts|moderation)/.test(id);
  return { text: true, vision, audio, video, tools };
}

// src/lib/kv.js
var CACHE_TTL_MS = 3e4;
var KEYS = {
  PROVIDERS: "providers",
  SETTINGS: "settings",
  APIKEYS: "apikeys"
};
var memCache = /* @__PURE__ */ new Map();
function getCache(key) {
  const hit = memCache.get(key);
  if (hit && hit.expireAt > Date.now()) return hit.value;
  return void 0;
}
function setCache(key, value) {
  memCache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}
async function readJson(env, key, fallback) {
  const cached = getCache(key);
  if (cached !== void 0) return cached;
  const raw = await env.KV.get(key);
  const value = raw ? JSON.parse(raw) : fallback;
  setCache(key, value);
  return value;
}
async function writeJson(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
  setCache(key, value);
}
async function getProviders(env) {
  return readJson(env, KEYS.PROVIDERS, []);
}
async function saveProviders(env, providers) {
  await writeJson(env, KEYS.PROVIDERS, providers);
}
async function getSettings(env) {
  return readJson(env, KEYS.SETTINGS, {
    siteTitle: "CF LLM Gateway",
    defaultModel: "auto"
    // "auto" = 按顺序故障转移；否则为 "providerSlug/modelId"
  });
}
async function saveSettings(env, settings) {
  await writeJson(env, KEYS.SETTINGS, settings);
}
async function getApiKeys(env) {
  return readJson(env, KEYS.APIKEYS, []);
}
async function saveApiKeys(env, keys) {
  await writeJson(env, KEYS.APIKEYS, keys);
}
var lastTouch = /* @__PURE__ */ new Map();
async function touchApiKeyUsage(env, hash) {
  const now = Date.now();
  const prev = lastTouch.get(hash) || 0;
  if (now - prev < 5 * 60 * 1e3) return;
  lastTouch.set(hash, now);
  const keys = await getApiKeys(env);
  const found = keys.find((k) => k.hash === hash);
  if (found) {
    found.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
    await saveApiKeys(env, keys);
  }
}

// src/lib/auth.js
var SESSION_TTL_MS = 12 * 60 * 60 * 1e3;
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function createAdminSession(env) {
  const secret = env.admin_password || "";
  const expireAt = Date.now() + SESSION_TTL_MS;
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expireAt)));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${expireAt}.${sig}`;
}
async function verifyAdminSession(env, token) {
  if (!token || !token.includes(".")) return false;
  const [expireAtStr, sig] = token.split(".");
  const expireAt = Number(expireAtStr);
  if (!expireAt || Date.now() > expireAt) return false;
  const secret = env.admin_password || "";
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expireAt)));
  const expectedSig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(sig, expectedSig);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function getSessionCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
async function requireAdmin(request, env) {
  const bearer = getBearerToken(request);
  if (bearer && bearer === env.admin_password) return true;
  const token = getSessionCookie(request);
  return verifyAdminSession(env, token);
}
function getApiKeyFromRequest(request) {
  const bearer = getBearerToken(request);
  if (bearer) return bearer;
  const xApiKey = request.headers.get("x-api-key");
  return xApiKey ? xApiKey.trim() : null;
}
async function verifyApiKey(request, env) {
  const token = getApiKeyFromRequest(request);
  if (!token) return { ok: false, reason: "missing_authorization" };
  const hash = await sha256Hex(token);
  const keys = await getApiKeys(env);
  const found = keys.find((k) => k.hash === hash && !k.revoked);
  if (!found) return { ok: false, reason: "invalid_api_key" };
  await touchApiKeyUsage(env, hash);
  return { ok: true, key: found };
}

// src/lib/proxy.js
function externalModelId(provider, model) {
  return `${slugify(provider.name)}/${model.id}`;
}
function enabledModels(provider) {
  return (provider.models || []).filter((m) => m.enabled !== false);
}
async function listModels(env) {
  const providers = (await getProviders(env)).filter((p) => p.enabled !== false);
  const data = [];
  for (const provider of providers.sort((a, b) => a.order - b.order)) {
    for (const model of enabledModels(provider)) {
      data.push({
        id: externalModelId(provider, model),
        object: "model",
        created: 0,
        owned_by: provider.name,
        capabilities: model.capabilities || {}
      });
    }
  }
  return { object: "list", data };
}
function findByExternalId(providers, externalId) {
  const idx = externalId.indexOf("/");
  if (idx === -1) return null;
  const slug = externalId.slice(0, idx);
  const modelId = externalId.slice(idx + 1);
  const provider = providers.find((p) => slugify(p.name) === slug);
  if (!provider) return null;
  const model = (provider.models || []).find((m) => m.id === modelId);
  if (!model) return null;
  return { provider, model };
}
async function callUpstream(provider, model, body, timeoutMs) {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = { ...body, model: model.id };
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(payload)
    },
    timeoutMs
  );
  return resp;
}
async function runProviderChain(env, body) {
  const providers = (await getProviders(env)).filter((p) => p.enabled !== false && p.apiKey && enabledModels(p).length > 0).sort((a, b) => a.order - b.order);
  if (providers.length === 0) {
    return { ok: false, status: 403, code: "no_provider_available", message: "No providers configured. Please add one in /admin first." };
  }
  const requestedModel = body.model;
  const explicit = requestedModel && requestedModel !== "auto" ? findByExternalId(providers, requestedModel) : null;
  const attempts = [];
  if (explicit) {
    attempts.push(explicit);
  } else {
    const settings = await getSettings(env);
    if (settings.defaultModel && settings.defaultModel !== "auto") {
      const preferred = findByExternalId(providers, settings.defaultModel);
      if (preferred) attempts.push(preferred);
    }
    for (const provider of providers) {
      const models = enabledModels(provider);
      const defaultModel = provider.defaultModelId ? models.find((m) => m.id === provider.defaultModelId) || models[0] : models[0];
      if (!defaultModel) continue;
      if (attempts.some((a) => a.provider.id === provider.id && a.model.id === defaultModel.id)) continue;
      attempts.push({ provider, model: defaultModel });
    }
  }
  let lastError = null;
  for (const { provider, model } of attempts) {
    try {
      const resp = await callUpstream(provider, model, body, 45e3);
      if (resp.ok) {
        return { ok: true, resp, provider, model };
      }
      lastError = `${provider.name}/${model.id}: HTTP ${resp.status}`;
      if (explicit) {
        return { ok: false, status: resp.status, code: "upstream_error", upstreamResp: resp, provider, model };
      }
    } catch (err) {
      lastError = `${provider.name}/${model.id}: ${err.message || "network error"}`;
      if (explicit) {
        return { ok: false, status: 502, code: "upstream_error", message: `Upstream request failed: ${lastError}` };
      }
    }
  }
  return {
    ok: false,
    status: 403,
    code: "all_models_unavailable",
    message: `All configured models failed or are unreachable. Last error: ${lastError || "unknown"}`
  };
}
async function handleChatCompletions(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }
  const result = await runProviderChain(env, body);
  if (!result.ok) {
    if (result.upstreamResp) {
      const text = await result.upstreamResp.text();
      return new Response(text, {
        status: result.upstreamResp.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return errorResponse(result.message, result.status, result.code);
  }
  const headers = new Headers(result.resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Upstream-Provider", result.provider.name);
  headers.set("X-Upstream-Model", result.model.id);
  return new Response(result.resp.body, { status: result.resp.status, headers });
}
async function fetchUpstreamModels(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const resp = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    2e4
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const list = data.data || data.models || [];
  return list.map((m) => typeof m === "string" ? m : m.id || m.name).filter(Boolean);
}

// src/lib/anthropic.js
function anthropicError(message, status = 400, type = "api_error") {
  return json({ type: "error", error: { type, message } }, status);
}
function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => typeof c === "string" ? c : c.text || (typeof c.content === "string" ? c.content : "")).filter(Boolean).join("\n");
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
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
      });
    } else if (b.type === "tool_result") {
      flush();
      out.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: extractTextFromContent(b.content) || ""
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
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  };
}
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return void 0;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return "auto";
}
function anthropicRequestToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sysText = Array.isArray(body.system) ? body.system.map((b) => typeof b === "string" ? b : b.text || "").join("\n") : body.system;
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  for (const m of body.messages || []) {
    messages.push(...convertAnthropicMessage(m));
  }
  const openaiBody = {
    model: body.model,
    messages,
    stream: !!body.stream
  };
  if (body.max_tokens != null) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) openaiBody.temperature = body.temperature;
  if (body.top_p != null) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    openaiBody.tools = body.tools.map(anthropicToolToOpenAI);
  }
  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (toolChoice !== void 0) openaiBody.tool_choice = toolChoice;
  return openaiBody;
}
var FINISH_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "end_turn"
};
function openAIResponseToAnthropic(data, fallbackModel) {
  const choice = data.choices && data.choices[0] || {};
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
        input
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
      output_tokens: usage.completion_tokens || 0
    }
  };
}
function createAnthropicSSEStream(openaiResponse, fallbackModel) {
  const reader = openaiResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const messageId = `msg_${crypto.randomUUID()}`;
  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      let nextBlockIndex = 0;
      let textBlockIndex = null;
      const toolBlocks = /* @__PURE__ */ new Map();
      let finishReason = null;
      const usage = { input_tokens: 0, output_tokens: 0 };
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}
data: ${JSON.stringify(data)}

`));
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
          usage
        }
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
              const choice = evt.choices && evt.choices[0] || {};
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
                      content_block: { type: "tool_use", id: entry.id, name: tc.function?.name || "", input: {} }
                    });
                  }
                  if (tc.function?.arguments) {
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: entry.anthropicIndex,
                      delta: { type: "input_json_delta", partial_json: tc.function.arguments }
                    });
                  }
                }
              }
              if (choice.finish_reason) finishReason = choice.finish_reason;
            }
          }
        }
      } catch {
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
        usage
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    }
  });
}
async function handleAnthropicMessages(request, env) {
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
        "X-Upstream-Model": modelId
      }
    });
  }
  const data = await result.resp.json();
  const anthropicJson = openAIResponseToAnthropic(data, modelId);
  return json(anthropicJson, 200, {
    "X-Upstream-Provider": result.provider.name,
    "X-Upstream-Model": modelId
  });
}

// src/lib/providers.js
var PROVIDER_PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    docs: "https://platform.openai.com/docs"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docs: "https://api-docs.deepseek.com/"
  },
  {
    id: "gemini",
    name: "Google Gemini (OpenAI \u517C\u5BB9\u5C42)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docs: "https://ai.google.dev/gemini-api/docs/openai"
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    docs: "https://build.nvidia.com/"
  },
  {
    id: "qwen",
    name: "\u963F\u91CC\u4E91\u901A\u4E49\u5343\u95EE (DashScope \u517C\u5BB9\u6A21\u5F0F)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docs: "https://help.aliyun.com/zh/dashscope/"
  },
  {
    id: "mimo",
    name: "\u5C0F\u7C73 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    docs: "https://xiaomimimo.com/"
  },
  {
    id: "moonshot",
    name: "\u6708\u4E4B\u6697\u9762 Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    docs: "https://platform.moonshot.cn/docs"
  },
  {
    id: "zhipu",
    name: "\u667A\u8C31 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docs: "https://open.bigmodel.cn/dev/api"
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    docs: "https://console.groq.com/docs"
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    docs: "https://docs.mistral.ai/"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    docs: "https://openrouter.ai/docs"
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    docs: "https://docs.together.ai/"
  },
  {
    id: "custom",
    name: "\u81EA\u5B9A\u4E49 (Custom OpenAI \u517C\u5BB9\u63A5\u53E3)",
    baseUrl: "",
    docs: ""
  }
];
function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

// src/admin/html.js
function renderAdminPage(siteTitle = "CF LLM Gateway") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${siteTitle} \xB7 \u7BA1\u7406\u9762\u677F</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded" rel="stylesheet">
<style>
:root{
  --md-primary:#6750A4; --md-on-primary:#ffffff; --md-primary-container:#EADDFF; --md-on-primary-container:#21005D;
  --md-surface:#FFFBFE; --md-surface-variant:#E7E0EC; --md-on-surface:#1C1B1F; --md-on-surface-variant:#49454F;
  --md-outline:#79747E; --md-error:#B3261E; --md-error-container:#F9DEDC; --md-on-error-container:#410E0B;
  --md-success:#146C2E; --md-success-container:#C6F0D0;
  --md-elevation-1: 0 1px 3px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.08);
  --md-elevation-2: 0 3px 6px rgba(0,0,0,.10), 0 2px 4px rgba(0,0,0,.08);
}
*{box-sizing:border-box;}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Arial,sans-serif;background:#F3EDF7;color:var(--md-on-surface);}
.material-symbols-rounded{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;vertical-align:middle;font-size:20px;}
.topbar{display:flex;align-items:center;gap:12px;padding:16px 24px;background:var(--md-surface);box-shadow:var(--md-elevation-1);position:sticky;top:0;z-index:10;}
.topbar h1{font-size:20px;font-weight:500;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.container{max-width:980px;margin:24px auto;padding:0 16px 64px;}
.card{background:var(--md-surface);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:var(--md-elevation-1);}
.card h2{font-size:16px;font-weight:500;margin:0 0 4px;display:flex;align-items:center;gap:8px;}
.card .desc{color:var(--md-on-surface-variant);font-size:13px;margin-bottom:16px;}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:20px;padding:10px 20px;font-size:14px;font-weight:500;cursor:pointer;background:var(--md-primary);color:var(--md-on-primary);transition:box-shadow .2s;}
.btn:hover{box-shadow:var(--md-elevation-2);}
.btn.outlined{background:transparent;color:var(--md-primary);border:1px solid var(--md-outline);}
.btn.text{background:transparent;color:var(--md-primary);padding:8px 12px;}
.btn.danger{background:var(--md-error);color:#fff;}
.btn.sm{padding:6px 12px;font-size:13px;}
.btn:disabled{opacity:.5;cursor:not-allowed;}
input,select{width:100%;padding:12px 14px;border-radius:8px;border:1px solid var(--md-outline);background:var(--md-surface);color:var(--md-on-surface);font-size:14px;font-family:inherit;}
input:focus,select:focus{outline:2px solid var(--md-primary);border-color:var(--md-primary);}
label{display:block;font-size:12px;color:var(--md-on-surface-variant);margin-bottom:6px;margin-top:12px;}
.row{display:flex;gap:12px;flex-wrap:wrap;}
.row > div{flex:1;min-width:180px;}
.provider{border:1px solid var(--md-surface-variant);border-radius:12px;padding:16px;margin-bottom:12px;}
.provider-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:8px;}
.provider-head .name{font-weight:500;flex:1;}
.badge{font-size:11px;padding:2px 8px;border-radius:8px;background:var(--md-primary-container);color:var(--md-on-primary-container);}
.badge.off{background:var(--md-surface-variant);color:var(--md-on-surface-variant);}
.model-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #eee;font-size:13px;flex-wrap:wrap;row-gap:6px;}
.model-row .mid{flex:1;font-family:monospace;min-width:120px;word-break:break-all;}
.cap-chips{display:flex;gap:4px;flex-wrap:wrap;}
.chip{display:inline-flex;align-items:center;gap:2px;font-size:10px;line-height:1.6;padding:3px 8px 3px 6px;border-radius:8px;background:transparent;color:var(--md-on-surface-variant);border:1px solid var(--md-outline);opacity:.5;}
.chip .material-symbols-rounded{font-size:12px;}
.chip.on{background:var(--md-primary-container);color:var(--md-on-primary-container);border-color:transparent;opacity:1;font-weight:500;}
.model-search{display:flex;align-items:center;gap:6px;background:var(--md-surface-variant);border-radius:10px;padding:6px 12px;margin:10px 0 8px;}
.model-search .material-symbols-rounded{font-size:16px;color:var(--md-on-surface-variant);}
.model-search input{flex:1;width:auto;border:none;background:transparent;padding:4px 0;font-size:13px;border-radius:0;}
.model-search input:focus{outline:none;border:none;}
.switch{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;}
.switch input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;inset:0;background:var(--md-surface-variant);border-radius:20px;transition:.2s;}
.slider:before{content:"";position:absolute;height:14px;width:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;}
input:checked + .slider{background:var(--md-primary);}
input:checked + .slider:before{transform:translateX(16px);}
.toast{position:fixed;top:20px;right:20px;left:auto;bottom:auto;background:#333;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;z-index:300;box-shadow:var(--md-elevation-2);max-width:320px;opacity:0;transform:translateX(32px);transition:opacity .25s cubic-bezier(0.05,0.7,0.1,1.0),transform .25s cubic-bezier(0.05,0.7,0.1,1.0);pointer-events:none;}
.toast.show{opacity:1;transform:translateX(0);}
.key-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #eee;font-size:13px;flex-wrap:wrap;row-gap:6px;}
.key-list-item .kname{flex:1;}
.mono{font-family:monospace;background:var(--md-surface-variant);padding:2px 6px;border-radius:6px;}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;}
.login-card{width:100%;max-width:340px;text-align:center;}
.login-card .material-symbols-rounded{font-size:40px;color:var(--md-primary);}
#login{transition:opacity .2s ease;}
#app{display:none;transition:opacity .2s ease;}
#login.fade-out,#app.fade-out{opacity:0;}
#login.fade-in,#app.fade-in{opacity:0;}
.order-btns{display:flex;flex-direction:column;gap:2px;}
.order-btns button{background:none;border:none;cursor:pointer;color:var(--md-on-surface-variant);padding:0;line-height:1;}
.hint{font-size:12px;color:var(--md-on-surface-variant);margin-top:6px;}
code.small{font-size:12px;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility .2s ease;}
.modal-overlay.show{opacity:1;visibility:visible;pointer-events:auto;}
.modal-dialog{background:var(--md-surface);border-radius:28px;padding:24px;width:min(440px,100%);box-shadow:var(--md-elevation-2);transform:scale(.92) translateY(8px);transition:transform .2s cubic-bezier(0.05,0.7,0.1,1.0);}
.modal-overlay.show .modal-dialog{transform:scale(1) translateY(0);}
.modal-icon{width:48px;height:48px;border-radius:50%;background:var(--md-primary-container);display:flex;align-items:center;justify-content:center;margin-bottom:16px;}
.modal-icon .material-symbols-rounded{color:var(--md-on-primary-container);font-size:24px;}
.modal-title{font-size:20px;line-height:28px;font-weight:400;margin:0 0 8px;color:var(--md-on-surface);}
.modal-desc{font-size:14px;line-height:20px;color:var(--md-on-surface-variant);margin:0 0 20px;}
.modal-key-box{background:var(--md-surface-variant);border-radius:12px;padding:14px 16px;margin-bottom:24px;}
.modal-key-box code{word-break:break-all;font-size:13px;line-height:1.5;color:var(--md-on-surface);}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;}

/* ==== \u79FB\u52A8\u7AEF\u9002\u914D\uFF08\u4EE5 320px \u5BBD\u5EA6\u4E3A\u57FA\u51C6\uFF09 ==== */
@media (max-width: 480px){
  .container{padding:0 12px 48px;margin:16px auto;}
  .card{padding:14px;border-radius:14px;margin-bottom:14px;}
  .card h2{font-size:15px;}
  .topbar{padding:10px 14px;gap:8px;}
  .topbar h1{font-size:16px;}
  .btn{padding:9px 16px;font-size:13px;}
  .btn.sm{padding:6px 10px;font-size:12px;}
  .row{gap:8px;}
  .row > div{min-width:100%;}
  label{font-size:11px;}
  input,select{padding:10px 12px;font-size:13px;}
  .provider{padding:12px;}
  .provider-head .name{font-size:14px;flex-basis:100%;order:-1;}
  .key-list-item{font-size:12px;}
  .key-list-item .kname{font-size:12px;flex-basis:100%;order:1;}
  .modal-overlay{padding:12px;}
  .modal-dialog{padding:18px;border-radius:20px;}
  .modal-title{font-size:17px;line-height:24px;}
  .modal-desc{font-size:13px;}
  .modal-key-box{padding:12px;}
  .modal-actions{flex-direction:column-reverse;gap:8px;}
  .modal-actions .btn{width:100%;justify-content:center;}
  /* toast \u5728\u7A84\u5C4F\u4E0B\u6539\u4E3A\u8D34\u9876\u6A2A\u5E45\u6837\u5F0F\uFF0C\u907F\u514D\u56FA\u5B9A max-width \u5BFC\u81F4\u6EA2\u51FA\u5C4F\u5E55 */
  .toast{left:12px;right:12px;top:12px;max-width:none;width:auto;transform:translateY(-16px);}
  .toast.show{transform:translateY(0);}
}
</style>
</head>
<body>

<div id="login" class="login-wrap">
  <div class="card login-card">
    <span class="material-symbols-rounded">lock</span>
    <h2 style="margin-top:8px">${siteTitle} \u7BA1\u7406\u767B\u5F55</h2>
    <input id="pwd" type="password" placeholder="\u7BA1\u7406\u5458\u5BC6\u7801" style="margin-top:12px" />
    <div style="margin-top:16px"><button class="btn" style="width:100%" onclick="doLogin()">\u767B\u5F55</button></div>
    <div id="loginErr" style="color:var(--md-error);font-size:13px;margin-top:8px"></div>
  </div>
</div>

<div id="app">
  <div class="topbar">
    <span class="material-symbols-rounded" style="color:var(--md-primary)">hub</span>
    <h1>${siteTitle} \xB7 \u7BA1\u7406\u9762\u677F</h1>
    <button class="btn text" onclick="logout()"><span class="material-symbols-rounded">logout</span>\u9000\u51FA</button>
  </div>

  <div class="container">

    <div class="card">
      <h2><span class="material-symbols-rounded">dns</span>\u670D\u52A1\u5546 / \u6A21\u578B</h2>
      <div class="desc">\u6309\u987A\u5E8F\u8C03\u7528\uFF1A\u5916\u90E8\u8BF7\u6C42\u4E0D\u6307\u5B9A\u6A21\u578B\uFF08\u6216\u9009\u62E9 auto\uFF09\u65F6\uFF0C\u5C06\u4ECE\u4E0A\u5230\u4E0B\u4F9D\u6B21\u5C1D\u8BD5\u6BCF\u4E2A\u670D\u52A1\u5546\u7684\u9ED8\u8BA4\u6A21\u578B\uFF0C\u7B2C\u4E00\u4E2A\u8C03\u7528\u6210\u529F\u5373\u8FD4\u56DE\u3002</div>
      <div id="providerList"></div>
      <button class="btn outlined sm" onclick="openAddProvider()"><span class="material-symbols-rounded">add</span>\u6DFB\u52A0\u670D\u52A1\u5546</button>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">tune</span>\u5168\u5C40\u8BBE\u7F6E</h2>
      <label>\u9ED8\u8BA4\u6A21\u578B\uFF08\u53EF\u8986\u76D6\u81EA\u52A8\u6545\u969C\u8F6C\u79FB\uFF0C\u586B auto \u8868\u793A\u6309\u987A\u5E8F\u81EA\u52A8\u9009\u62E9\uFF09</label>
      <input id="s_defaultModel" placeholder="auto \u6216 deepseek/deepseek-chat" />
      <div style="margin-top:16px"><button class="btn" onclick="saveSettings()">\u4FDD\u5B58\u8BBE\u7F6E</button></div>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">vpn_key</span>\u5BF9\u5916 API Key</h2>
      <div class="desc">\u7528\u4E8E\u90E8\u7F72\u5230 Claude Code / AstrBot \u7B49\u5916\u90E8\u9879\u76EE\u3002\u5BC6\u94A5\u4EC5\u5728\u521B\u5EFA\u65F6\u5B8C\u6574\u663E\u793A\u4E00\u6B21\uFF0C\u8BF7\u7ACB\u5373\u4FDD\u5B58\u3002</div>
      <button class="btn" onclick="openNameModal()"><span class="material-symbols-rounded">add</span>\u751F\u6210\u65B0\u5BC6\u94A5</button>
      <div id="keyList"></div>
    </div>

    <div class="card">
      <h2><span class="material-symbols-rounded">integration_instructions</span>\u63A5\u5165\u65B9\u5F0F</h2>

      <label style="margin-top:0">OpenAI \u517C\u5BB9\uFF08AstrBot / \u5927\u591A\u6570\u7B2C\u4E09\u65B9\u5BA2\u6237\u7AEF\uFF09</label>
      <div class="desc" style="margin-bottom:6px">Base URL \u586B\u4E0B\u9762\u5730\u5740\uFF0CAPI Key \u4F7F\u7528\u4E0A\u65B9\u751F\u6210\u7684\u5BC6\u94A5\uFF1A</div>
      <code class="mono small" id="apiBaseOpenAI"></code>

      <label>Anthropic \u517C\u5BB9\uFF08Claude Code \u7B49\u539F\u751F Anthropic \u534F\u8BAE\u5BA2\u6237\u7AEF\uFF09</label>
      <div class="desc" style="margin-bottom:6px">\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF <code class="mono small">ANTHROPIC_BASE_URL</code> \u4E3A\u4E0B\u9762\u5730\u5740\uFF08\u5BA2\u6237\u7AEF\u4F1A\u81EA\u52A8\u8BF7\u6C42
        <code class="mono small">/v1/messages</code>\uFF09\uFF0C<code class="mono small">ANTHROPIC_AUTH_TOKEN</code>
        / <code class="mono small">ANTHROPIC_API_KEY</code> \u4F7F\u7528\u4E0A\u65B9\u751F\u6210\u7684\u5BC6\u94A5\uFF1A</div>
      <code class="mono small" id="apiBaseAnthropic"></code>
      <div class="hint">\u793A\u4F8B\uFF08\u7EC8\u7AEF\u91CC\u4E34\u65F6\u8BBE\u7F6E\u540E\u8FD0\u884C Claude Code\uFF09\uFF1A</div>
      <code class="mono small" id="anthropicExample" style="display:block;white-space:pre-wrap;margin-top:4px"></code>
    </div>

  </div>
</div>

<div id="keyNameModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeNameModal()">
  <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="keyNameModalTitle">
    <div class="modal-icon"><span class="material-symbols-rounded">edit_note</span></div>
    <h3 class="modal-title" id="keyNameModalTitle">\u4E3A\u65B0\u5BC6\u94A5\u6DFB\u52A0\u5907\u6CE8</h3>
    <p class="modal-desc">\u5907\u6CE8\u7528\u4E8E\u533A\u5206\u4E0D\u540C\u7528\u9014\u7684\u5BC6\u94A5\uFF08\u4F8B\u5982\u90E8\u7F72\u7684\u9879\u76EE\u540D\uFF09\uFF0C\u5FC5\u987B\u586B\u5199\u3002</p>
    <input id="k_name" placeholder="\u4F8B\u5982 my-astrbot" onkeydown="if(event.key==='Enter') confirmCreateKey()" />
    <div id="k_name_error" style="color:var(--md-error);font-size:12px;margin-top:6px;display:none">\u8BF7\u8F93\u5165\u5BC6\u94A5\u5907\u6CE8</div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn text" onclick="closeNameModal()">\u53D6\u6D88</button>
      <button class="btn" onclick="confirmCreateKey()">\u4E0B\u4E00\u6B65</button>
    </div>
  </div>
</div>

<div id="keyModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeKeyModal()">
  <div class="modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="keyModalTitle">
    <div class="modal-icon"><span class="material-symbols-rounded">vpn_key</span></div>
    <h3 class="modal-title" id="keyModalTitle">\u65B0\u5BC6\u94A5\u5DF2\u751F\u6210</h3>
    <p class="modal-desc">\u8BF7\u7ACB\u5373\u590D\u5236\u4FDD\u5B58\uFF0C\u51FA\u4E8E\u5B89\u5168\u8003\u8651\uFF0C\u6B64\u5BC6\u94A5\u4EC5\u5728\u6B64\u523B\u663E\u793A\uFF0C\u5173\u95ED\u540E\u5C06\u65E0\u6CD5\u518D\u6B21\u67E5\u770B\u5B8C\u6574\u5185\u5BB9\u3002</p>
    <div class="modal-key-box"><code class="mono" id="modalKeyValue"></code></div>
    <div class="modal-actions">
      <button class="btn text" onclick="closeKeyModal()">\u5173\u95ED</button>
      <button class="btn" onclick="copyKeyValue()"><span class="material-symbols-rounded">content_copy</span>\u590D\u5236</button>
    </div>
  </div>
</div>

<div id="addProviderModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeAddProvider()">
  <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="addProviderModalTitle" style="width:min(480px,100%)">
    <div class="modal-icon"><span class="material-symbols-rounded">add_circle</span></div>
    <h3 class="modal-title" id="addProviderModalTitle">\u65B0\u589E\u670D\u52A1\u5546</h3>
    <div class="row">
      <div>
        <label style="margin-top:0">\u9884\u8BBE\u6A21\u677F</label>
        <select id="np_preset" onchange="onPresetChange()"></select>
      </div>
      <div>
        <label style="margin-top:0">\u663E\u793A\u540D\u79F0</label>
        <input id="np_name" placeholder="\u4F8B\u5982 DeepSeek" />
      </div>
    </div>
    <label>Base URL\uFF08OpenAI \u517C\u5BB9\u63A5\u53E3\u6839\u5730\u5740\uFF09</label>
    <input id="np_baseUrl" placeholder="https://api.deepseek.com/v1" />
    <label>API Key</label>
    <input id="np_apiKey" placeholder="sk-..." />
    <div class="hint">\u4FDD\u5B58\u540E\u53EF\u70B9\u51FB\u300C\u641C\u7D22\u6A21\u578B\u300D\u81EA\u52A8\u62C9\u53D6\u8BE5\u670D\u52A1\u5546\u4E0B\u53EF\u7528\u7684\u6A21\u578B\u5217\u8868\u3002</div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn text" onclick="closeAddProvider()">\u53D6\u6D88</button>
      <button class="btn" onclick="saveNewProvider()">\u4FDD\u5B58</button>
    </div>
  </div>
</div>

<div id="confirmModalOverlay" class="modal-overlay" onclick="if(event.target===this) closeConfirmModal()">
  <div class="modal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmModalTitle">
    <div class="modal-icon" style="background:var(--md-error-container)"><span class="material-symbols-rounded" style="color:var(--md-on-error-container)">warning</span></div>
    <h3 class="modal-title" id="confirmModalTitle">\u786E\u8BA4\u5220\u9664</h3>
    <p class="modal-desc" id="confirmModalDesc"></p>
    <div class="modal-actions">
      <button class="btn text" onclick="closeConfirmModal()">\u53D6\u6D88</button>
      <button class="btn danger" id="confirmModalConfirmBtn" onclick="handleConfirmModalConfirm()">\u5220\u9664</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const ORIGIN = location.origin;
document.getElementById('apiBaseOpenAI').textContent = ORIGIN + '/v1';
document.getElementById('apiBaseAnthropic').textContent = ORIGIN;
document.getElementById('anthropicExample').textContent =
  'export ANTHROPIC_BASE_URL="' + ORIGIN + '"\\n' +
  'export ANTHROPIC_AUTH_TOKEN="\u4F60\u751F\u6210\u7684sk-cfg-...\u5BC6\u94A5"\\n' +
  'claude';
let STATE = null;
let PRESETS = [];

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

async function api(path, opts={}){
  const resp = await fetch(path, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers||{}) } });
  if (resp.status === 401){ showLogin(); throw new Error('unauthorized'); }
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) throw new Error(data.error?.message || ('HTTP '+resp.status));
  return data;
}

function crossFade(hideId, showId, showDisplay){
  const hideEl = document.getElementById(hideId);
  const showEl = document.getElementById(showId);
  const reveal = () => {
    showEl.style.display = showDisplay;
    showEl.classList.add('fade-in');
    // \u5F3A\u5236\u89E6\u53D1\u4E00\u6B21\u91CD\u6392\uFF0C\u786E\u4FDD\u6D4F\u89C8\u5668\u5148\u5E94\u7528 opacity:0 \u7684\u521D\u59CB\u72B6\u6001\uFF0C
    // \u518D\u5728\u4E0B\u4E00\u5E27\u79FB\u9664\u8BE5\u7C7B\u4EE5\u89E6\u53D1\u8FC7\u6E21\u52A8\u753B\uFF0C\u5426\u5219\u8FC7\u6E21\u4F1A\u88AB\u76F4\u63A5\u8DF3\u8FC7\u3002
    requestAnimationFrame(() => requestAnimationFrame(() => {
      showEl.classList.remove('fade-in');
    }));
  };
  const isHiddenAlready = getComputedStyle(hideEl).display === 'none';
  if (isHiddenAlready) {
    reveal();
    return;
  }
  hideEl.classList.add('fade-out');
  setTimeout(() => {
    hideEl.style.display = 'none';
    hideEl.classList.remove('fade-out');
    reveal();
  }, 200);
}
function showLogin(){
  crossFade('app', 'login', 'flex');
}
function showApp(){
  crossFade('login', 'app', 'block');
}

async function doLogin(){
  const pwd = document.getElementById('pwd').value;
  try{
    await api('/admin/api/login', { method:'POST', body: JSON.stringify({ password: pwd }) });
    document.getElementById('loginErr').textContent='';
    showApp();
    await loadAll();
  }catch(e){
    document.getElementById('loginErr').textContent = '\u5BC6\u7801\u9519\u8BEF';
  }
}
async function logout(){
  await api('/admin/api/logout', { method:'POST' });
  showLogin();
}

async function loadAll(){
  const [state, presets] = await Promise.all([ api('/admin/api/state'), api('/admin/api/presets') ]);
  STATE = state; PRESETS = presets.presets;
  renderPresetSelect();
  renderProviders();
  document.getElementById('s_defaultModel').value = state.settings.defaultModel || 'auto';
  renderKeys();
}

function renderPresetSelect(){
  const sel = document.getElementById('np_preset');
  sel.innerHTML = PRESETS.map(p=>'<option value="'+p.id+'">'+p.name+'</option>').join('');
  onPresetChange();
}
function onPresetChange(){
  const id = document.getElementById('np_preset').value;
  const p = PRESETS.find(x=>x.id===id);
  if(!p) return;
  const nameInput = document.getElementById('np_name');
  const baseUrlInput = document.getElementById('np_baseUrl');
  const currentName = nameInput.value.trim();
  // \u53EA\u6709\u5F53\u540D\u79F0\u4E3A\u7A7A\uFF0C\u6216\u8005\u8FD8\u7B49\u4E8E"\u4E4B\u524D\u67D0\u4E2A\u9884\u8BBE\u7684\u9ED8\u8BA4\u540D\u79F0"\u65F6\u624D\u81EA\u52A8\u8DDF\u968F\u5207\u6362\uFF1B
  // \u5982\u679C\u7528\u6237\u5DF2\u7ECF\u624B\u52A8\u6539\u6210\u4E86\u81EA\u5DF1\u7684\u540D\u5B57\uFF0C\u5219\u4E0D\u8986\u76D6\uFF0C\u907F\u514D\u6253\u65AD\u7528\u6237\u8F93\u5165\u3002
  const isUntouched = currentName === '' || PRESETS.some(preset => preset.name === currentName);
  if (isUntouched) {
    nameInput.value = p.id === 'custom' ? '' : p.name;
  }
  baseUrlInput.value = p.baseUrl || '';
}

function capChips(caps={}){
  const map = {
    vision: { label:'\u89C6\u89C9', icon:'visibility' },
    audio: { label:'\u97F3\u9891', icon:'mic' },
    video: { label:'\u89C6\u9891', icon:'videocam' },
    tools: { label:'\u5DE5\u5177\u8C03\u7528', icon:'build' },
  };
  const chips = Object.keys(map).map(k=>{
    const info = map[k];
    return '<span class="chip '+(caps[k]?'on':'')+'"><span class="material-symbols-rounded">'+info.icon+'</span>'+info.label+'</span>';
  }).join('');
  return '<div class="cap-chips">'+chips+'</div>';
}

function renderProviders(){
  const el = document.getElementById('providerList');
  const providers = [...STATE.providers].sort((a,b)=>a.order-b.order);
  if(providers.length===0){ el.innerHTML='<div class="desc">\u6682\u65E0\u670D\u52A1\u5546\uFF0C\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u6DFB\u52A0\u3002</div>'; return; }
  el.innerHTML = providers.map((p, idx)=>{
    const hasModels = (p.models||[]).length > 0;
    return '<div class="provider">'
      +'<div class="provider-head">'
        +'<div class="order-btns">'
          +'<button onclick="moveProvider(\\''+p.id+'\\',-1)" '+(idx===0?'disabled':'')+'><span class="material-symbols-rounded">arrow_drop_up</span></button>'
          +'<button onclick="moveProvider(\\''+p.id+'\\',1)" '+(idx===providers.length-1?'disabled':'')+'><span class="material-symbols-rounded">arrow_drop_down</span></button>'
        +'</div>'
        +'<span class="name">'+(idx+1)+'. '+p.name+'</span>'
        +'<span class="badge '+(p.enabled===false?'off':'')+'">'+(p.enabled===false?'\u5DF2\u505C\u7528':'\u542F\u7528\u4E2D')+'</span>'
        +'<label class="switch"><input type="checkbox" '+(p.enabled!==false?'checked':'')+' onchange="toggleProvider(\\''+p.id+'\\', this.checked)"><span class="slider"></span></label>'
        +'<button class="btn text sm" onclick="searchModels(\\''+p.id+'\\')"><span class="material-symbols-rounded">search</span>\u641C\u7D22\u6A21\u578B</button>'
        +'<button class="btn text sm" onclick="deleteProvider(\\''+p.id+'\\')" style="color:var(--md-error)"><span class="material-symbols-rounded">delete</span></button>'
      +'</div>'
      +'<div class="hint">'+p.baseUrl+'</div>'
      + (hasModels
          ? '<div class="model-search"><span class="material-symbols-rounded">search</span><input type="text" placeholder="\u6309\u6A21\u578B\u540D\u79F0 / ID \u7B5B\u9009" id="modelFilter_'+p.id+'" oninput="renderModelList(\\''+p.id+'\\')" /></div>'
          : '')
      +'<div id="models_'+p.id+'"></div>'
    +'</div>';
  }).join('');
  providers.forEach(p => renderModelList(p.id));
}

// \u53EA\u91CD\u65B0\u6E32\u67D3\u67D0\u4E2A\u670D\u52A1\u5546\u7684\u6A21\u578B\u5217\u8868\uFF08\u4E0D\u91CD\u5EFA\u7B5B\u9009\u8F93\u5165\u6846\u7B49\u5916\u5C42\u7ED3\u6784\uFF09\uFF0C
// \u8FD9\u6837\u5728\u7B5B\u9009\u6846\u91CC\u8F93\u5165\u65F6\u4E0D\u4F1A\u4E22\u5931\u8F93\u5165\u7126\u70B9\u3002
function renderModelList(providerId){
  const p = findProvider(providerId);
  const container = document.getElementById('models_'+providerId);
  if(!p || !container) return;
  const allModels = p.models || [];
  if(!allModels.length){
    container.innerHTML = '<div class="hint">\u5C1A\u672A\u5BFC\u5165\u6A21\u578B\uFF0C\u70B9\u51FB"\u641C\u7D22\u6A21\u578B"\u4ECE\u4E0A\u6E38\u62C9\u53D6\u3002</div>';
    return;
  }
  const filterInput = document.getElementById('modelFilter_'+providerId);
  const filterText = filterInput ? filterInput.value.trim().toLowerCase() : '';
  const models = filterText ? allModels.filter(m => m.id.toLowerCase().includes(filterText)) : allModels;
  if(!models.length){
    container.innerHTML = '<div class="hint">\u6CA1\u6709\u5339\u914D"'+filterText+'"\u7684\u6A21\u578B\u3002</div>';
    return;
  }
  container.innerHTML = models.map(m=>
    '<div class="model-row">'
      +'<input type="radio" name="def_'+providerId+'" '+(p.defaultModelId===m.id?'checked':'')+' onchange="setDefaultModel(\\''+providerId+'\\',\\''+m.id+'\\')" title="\u8BBE\u4E3A\u8BE5\u670D\u52A1\u5546\u9ED8\u8BA4\u8C03\u7528\u6A21\u578B" />'
      +'<span class="mid">'+m.id+'</span>'
      + capChips(m.capabilities)
      +'<label class="switch"><input type="checkbox" '+(m.enabled!==false?'checked':'')+' onchange="toggleModel(\\''+providerId+'\\',\\''+m.id+'\\',this.checked)"><span class="slider"></span></label>'
    +'</div>'
  ).join('');
}

function findProvider(id){ return STATE.providers.find(p=>p.id===id); }

async function toggleProvider(id, enabled){
  await api('/admin/api/providers/'+id, { method:'PUT', body: JSON.stringify({ enabled }) });
  findProvider(id).enabled = enabled;
  renderProviders();
}
async function toggleModel(pid, mid, enabled){
  const p = findProvider(pid);
  const m = p.models.find(x=>x.id===mid);
  m.enabled = enabled;
  await api('/admin/api/providers/'+pid, { method:'PUT', body: JSON.stringify({ models: p.models }) });
}
async function setDefaultModel(pid, mid){
  await api('/admin/api/providers/'+pid, { method:'PUT', body: JSON.stringify({ defaultModelId: mid }) });
  findProvider(pid).defaultModelId = mid;
  renderProviders();
  toast('\u5DF2\u8BBE\u7F6E\u9ED8\u8BA4\u6A21\u578B');
}
async function moveProvider(id, dir){
  const providers = [...STATE.providers].sort((a,b)=>a.order-b.order);
  const idx = providers.findIndex(p=>p.id===id);
  const swapIdx = idx+dir;
  if(swapIdx<0 || swapIdx>=providers.length) return;
  [providers[idx].order, providers[swapIdx].order] = [providers[swapIdx].order, providers[idx].order];
  await api('/admin/api/providers/reorder', { method:'POST', body: JSON.stringify({ order: providers.map(p=>({id:p.id, order:p.order})) }) });
  STATE.providers = providers;
  renderProviders();
}
let confirmModalCallback = null;
function openConfirmModal(title, desc, onConfirm){
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalDesc').textContent = desc;
  confirmModalCallback = onConfirm;
  document.getElementById('confirmModalOverlay').classList.add('show');
}
function closeConfirmModal(){
  document.getElementById('confirmModalOverlay').classList.remove('show');
  confirmModalCallback = null;
}
async function handleConfirmModalConfirm(){
  const cb = confirmModalCallback;
  closeConfirmModal();
  if (cb) await cb();
}

async function deleteProvider(id){
  const p = findProvider(id);
  openConfirmModal(
    '\u5220\u9664\u8BE5\u670D\u52A1\u5546\uFF1F',
    '\u5C06\u540C\u65F6\u79FB\u9664 "'+(p?p.name:'\u8BE5\u670D\u52A1\u5546')+'" \u4E0B\u5DF2\u5BFC\u5165\u7684\u6240\u6709\u6A21\u578B\uFF0C\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u56DE\u3002',
    async () => {
      await api('/admin/api/providers/'+id, { method:'DELETE' });
      STATE.providers = STATE.providers.filter(x=>x.id!==id);
      renderProviders();
      toast('\u5220\u9664\u6210\u529F');
    }
  );
}
async function searchModels(id){
  toast('\u6B63\u5728\u641C\u7D22\u6A21\u578B...');
  try{
    const res = await api('/admin/api/providers/'+id+'/search-models', { method:'POST' });
    findProvider(id).models = res.models;
    renderProviders();
    toast('\u5DF2\u5BFC\u5165 '+res.models.length+' \u4E2A\u6A21\u578B\uFF0C\u8BF7\u9009\u62E9\u9700\u8981\u542F\u7528\u7684\u7248\u672C');
  }catch(e){ toast('\u641C\u7D22\u5931\u8D25: '+e.message); }
}

function openAddProvider(){ document.getElementById('addProviderModalOverlay').classList.add('show'); }
function closeAddProvider(){ document.getElementById('addProviderModalOverlay').classList.remove('show'); }
async function saveNewProvider(){
  const preset = document.getElementById('np_preset').value;
  const name = document.getElementById('np_name').value.trim();
  const baseUrl = document.getElementById('np_baseUrl').value.trim();
  const apiKey = document.getElementById('np_apiKey').value.trim();
  if(!name || !baseUrl || !apiKey){ toast('\u8BF7\u586B\u5199\u5B8C\u6574\u4FE1\u606F'); return; }
  const res = await api('/admin/api/providers', { method:'POST', body: JSON.stringify({ preset, name, baseUrl, apiKey }) });
  STATE.providers.push(res.provider);
  closeAddProvider();
  document.getElementById('np_name').value=''; document.getElementById('np_baseUrl').value=''; document.getElementById('np_apiKey').value='';
  renderProviders();
  toast('\u5BFC\u5165\u6210\u529F');
}

async function saveSettings(){
  const defaultModel = document.getElementById('s_defaultModel').value.trim() || 'auto';
  await api('/admin/api/settings', { method:'PUT', body: JSON.stringify({ defaultModel }) });
  toast('\u8BBE\u7F6E\u5DF2\u4FDD\u5B58');
}

let currentGeneratedKey = '';

function openNameModal(){
  const input = document.getElementById('k_name');
  input.value = '';
  document.getElementById('k_name_error').style.display = 'none';
  document.getElementById('keyNameModalOverlay').classList.add('show');
  setTimeout(() => input.focus(), 50);
}
function closeNameModal(){
  document.getElementById('keyNameModalOverlay').classList.remove('show');
}
function renderKeys(){
  const el = document.getElementById('keyList');
  const keys = STATE.apikeys || [];
  el.innerHTML = keys.map(k=>
    '<div class="key-list-item">'
      +'<span class="mono">'+k.prefix+'...</span>'
      +'<span class="kname">'+(k.name||'\u672A\u547D\u540D')+' \xB7 \u521B\u5EFA\u4E8E '+new Date(k.createdAt).toLocaleString()+(k.lastUsedAt? ' \xB7 \u6700\u8FD1\u4F7F\u7528 '+new Date(k.lastUsedAt).toLocaleString() : '')+'</span>'
      +'<button class="btn text sm" style="color:var(--md-error)" onclick="confirmRevokeKey(\\''+k.id+'\\')"><span class="material-symbols-rounded">delete</span>\u64A4\u9500</button>'
    +'</div>'
  ).join(''); // \u5217\u8868\u4E3A\u7A7A\u65F6\u4E0D\u663E\u793A\u4EFB\u4F55\u5360\u4F4D\u6587\u5B57
}
function confirmRevokeKey(id){
  const key = (STATE.apikeys || []).find(k => k.id === id);
  const label = key ? (key.name || '\u672A\u547D\u540D') : '\u8BE5\u5BC6\u94A5';
  openConfirmModal(
    '\u5220\u9664\u8BE5\u5BC6\u94A5\uFF1F',
    '\u64A4\u9500\u540E "'+label+'" \u5C06\u7ACB\u5373\u5931\u6548\uFF0C\u4F7F\u7528\u8BE5\u5BC6\u94A5\u7684\u9879\u76EE\u4F1A\u7ACB\u523B\u65AD\u5F00\uFF0C\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u56DE\u3002',
    async () => {
      await api('/admin/api/apikeys/'+id, { method:'DELETE' });
      STATE.apikeys = STATE.apikeys.filter(k=>k.id!==id);
      renderKeys();
      toast('\u5220\u9664\u6210\u529F');
    }
  );
}
async function confirmCreateKey(){
  const input = document.getElementById('k_name');
  const name = input.value.trim();
  const errorEl = document.getElementById('k_name_error');
  if (!name) {
    errorEl.style.display = 'block';
    input.focus();
    return;
  }
  errorEl.style.display = 'none';
  const res = await api('/admin/api/apikeys', { method:'POST', body: JSON.stringify({ name }) });
  STATE.apikeys.push(res.meta);
  renderKeys();
  closeNameModal();
  openKeyModal(res.key);
}
function openKeyModal(key){
  currentGeneratedKey = key;
  document.getElementById('modalKeyValue').textContent = key;
  document.getElementById('keyModalOverlay').classList.add('show');
}
function closeKeyModal(){
  document.getElementById('keyModalOverlay').classList.remove('show');
  currentGeneratedKey = '';
}
async function copyKeyValue(){
  try{
    await navigator.clipboard.writeText(currentGeneratedKey);
    toast('\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F');
  }catch(e){
    toast('\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u957F\u6309/\u9009\u4E2D\u540E\u624B\u52A8\u590D\u5236');
  }
}

document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){ closeKeyModal(); closeNameModal(); closeConfirmModal(); closeAddProvider(); }
});

// \u5C1D\u8BD5\u81EA\u52A8\u6062\u590D\u5DF2\u767B\u5F55\u72B6\u6001
(async ()=>{
  try{ await api('/admin/api/state'); showApp(); await loadAll(); }
  catch(e){ showLogin(); }
})();
</script>
</body>
</html>`;
}

// src/index.js
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      if (path === "/v1/chat/completions" && request.method === "POST") {
        const auth = await verifyApiKey(request, env);
        if (!auth.ok) return errorResponse("Invalid API key", 401, "invalid_api_key");
        return await handleChatCompletions(request, env);
      }
      if (path === "/v1/models" && request.method === "GET") {
        const auth = await verifyApiKey(request, env);
        if (!auth.ok) return errorResponse("Invalid API key", 401, "invalid_api_key");
        return json(await listModels(env));
      }
      if (path === "/v1/messages" && request.method === "POST") {
        const auth = await verifyApiKey(request, env);
        if (!auth.ok) return anthropicError("Invalid API key", 401, "authentication_error");
        return await handleAnthropicMessages(request, env);
      }
      if (path === "/" || path === "/health") {
        return json({ status: "ok", service: "cf-llm-gateway" });
      }
      if (path === "/admin" || path === "/admin/") {
        const settings = await getSettings(env);
        return new Response(renderAdminPage(settings.siteTitle), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if (path.startsWith("/admin/api/")) {
        return await handleAdminApi(request, env, path);
      }
      return errorResponse("Not found", 404, "not_found");
    } catch (err) {
      return errorResponse(`Internal error: ${err.message || err}`, 500, "internal_error");
    }
  }
};
async function handleAdminApi(request, env, path) {
  if (path === "/admin/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!env.admin_password) {
      return errorResponse("admin_password variable is not configured on the server", 500);
    }
    if (body.password !== env.admin_password) {
      return errorResponse("Incorrect password", 401, "unauthorized");
    }
    const token = await createAdminSession(env);
    return json(
      { ok: true },
      200,
      { "Set-Cookie": `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` }
    );
  }
  if (path === "/admin/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": "admin_session=; Path=/; HttpOnly; Max-Age=0" });
  }
  const isAdmin = await requireAdmin(request, env);
  if (!isAdmin) return errorResponse("Unauthorized", 401, "unauthorized");
  if (path === "/admin/api/presets" && request.method === "GET") {
    return json({ presets: PROVIDER_PRESETS });
  }
  if (path === "/admin/api/state" && request.method === "GET") {
    const [providers, settings, apikeys] = await Promise.all([getProviders(env), getSettings(env), getApiKeys(env)]);
    return json({
      providers,
      settings,
      // 已撤销的密钥不再下发给前端，否则刷新页面后会重新显示在列表里
      apikeys: apikeys.filter((k) => !k.revoked).map(({ hash, ...meta }) => meta)
    });
  }
  if (path === "/admin/api/settings" && request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const current = await getSettings(env);
    const updated = { ...current, ...body };
    await saveSettings(env, updated);
    return json({ ok: true, settings: updated });
  }
  if (path === "/admin/api/providers" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.name || !body.baseUrl || !body.apiKey) {
      return errorResponse("name, baseUrl and apiKey are required", 400);
    }
    const providers = await getProviders(env);
    const preset = findPreset(body.preset);
    const provider = {
      id: uuid(),
      name: body.name,
      preset: preset.id,
      baseUrl: body.baseUrl.replace(/\/$/, ""),
      apiKey: body.apiKey,
      enabled: true,
      order: providers.length,
      defaultModelId: null,
      models: []
    };
    providers.push(provider);
    await saveProviders(env, providers);
    return json({ ok: true, provider });
  }
  const providerIdMatch = path.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (providerIdMatch && request.method === "PUT") {
    const id = providerIdMatch[1];
    const body = await request.json().catch(() => ({}));
    const providers = await getProviders(env);
    const provider = providers.find((p) => p.id === id);
    if (!provider) return errorResponse("Provider not found", 404);
    Object.assign(provider, body);
    await saveProviders(env, providers);
    return json({ ok: true, provider });
  }
  if (providerIdMatch && request.method === "DELETE") {
    const id = providerIdMatch[1];
    const providers = (await getProviders(env)).filter((p) => p.id !== id);
    await saveProviders(env, providers);
    return json({ ok: true });
  }
  if (path === "/admin/api/providers/reorder" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const providers = await getProviders(env);
    for (const item of body.order || []) {
      const p = providers.find((x) => x.id === item.id);
      if (p) p.order = item.order;
    }
    await saveProviders(env, providers);
    return json({ ok: true });
  }
  const searchMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/search-models$/);
  if (searchMatch && request.method === "POST") {
    const id = searchMatch[1];
    const providers = await getProviders(env);
    const provider = providers.find((p) => p.id === id);
    if (!provider) return errorResponse("Provider not found", 404);
    let ids;
    try {
      ids = await fetchUpstreamModels(provider.baseUrl, provider.apiKey);
    } catch (err) {
      return errorResponse(`Failed to fetch model list from provider: ${err.message}`, 502, "upstream_error");
    }
    const existing = new Map((provider.models || []).map((m) => [m.id, m]));
    const merged = ids.map((mid) => existing.get(mid) || { id: mid, enabled: false, capabilities: guessCapabilities(mid) });
    provider.models = merged;
    await saveProviders(env, providers);
    return json({ ok: true, models: provider.models });
  }
  if (path === "/admin/api/apikeys" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { key, hash, prefix } = await generateApiKey();
    const keys = await getApiKeys(env);
    const meta = { id: uuid(), name: body.name || "", prefix, hash, createdAt: (/* @__PURE__ */ new Date()).toISOString(), lastUsedAt: null, revoked: false };
    keys.push(meta);
    await saveApiKeys(env, keys);
    const { hash: _drop, ...safeMeta } = meta;
    return json({ ok: true, key, meta: safeMeta });
  }
  const keyIdMatch = path.match(/^\/admin\/api\/apikeys\/([^/]+)$/);
  if (keyIdMatch && request.method === "DELETE") {
    const id = keyIdMatch[1];
    const keys = await getApiKeys(env);
    const remaining = keys.filter((k) => k.id !== id);
    await saveApiKeys(env, remaining);
    return json({ ok: true });
  }
  return errorResponse("Not found", 404, "not_found");
}
export {
  index_default as default
};
