import { getProviders, getSettings } from "./kv.js";
import { errorResponse, fetchWithTimeout, slugify, json } from "./utils.js";

// 对外暴露的模型 id 格式： "<providerSlug>/<modelId>"
export function externalModelId(provider, model) {
  return `${slugify(provider.name)}/${model.id}`;
}

function enabledModels(provider) {
  return (provider.models || []).filter((m) => m.enabled !== false);
}

// 生成 /v1/models 返回内容，聚合所有已启用服务商的已启用模型
export async function listModels(env) {
  const providers = (await getProviders(env)).filter((p) => p.enabled !== false);
  const data = [];
  for (const provider of providers.sort((a, b) => a.order - b.order)) {
    for (const model of enabledModels(provider)) {
      data.push({
        id: externalModelId(provider, model),
        object: "model",
        created: 0,
        owned_by: provider.name,
        capabilities: model.capabilities || {},
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
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(payload),
    },
    timeoutMs
  );
  return resp;
}

// 核心故障转移链，被 OpenAI 格式 (/v1/chat/completions) 和 Anthropic 格式 (/v1/messages)
// 两个入口共用。body 必须已经是 OpenAI chat-completions 格式。
// 规则：
//  - 若 body.model 明确指向某个已导入的 "provider/model"，只调用这一个，失败即返回错误（不做故障转移）
//  - 若 body.model 缺省 / 为 "auto" / 不匹配任何已知模型，则按 provider.order 顺序依次尝试，
//    每个 provider 使用其默认模型（或第一个已启用模型），第一个调用成功即返回，不再继续尝试后续模型
//  - 所有模型都不可用 -> ok:false, status:403
export async function runProviderChain(env, body) {
  const providers = (await getProviders(env))
    .filter((p) => p.enabled !== false && p.apiKey && enabledModels(p).length > 0)
    .sort((a, b) => a.order - b.order);

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
      const defaultModel = provider.defaultModelId
        ? models.find((m) => m.id === provider.defaultModelId) || models[0]
        : models[0];
      if (!defaultModel) continue;
      if (attempts.some((a) => a.provider.id === provider.id && a.model.id === defaultModel.id)) continue;
      attempts.push({ provider, model: defaultModel });
    }
  }

  let lastError = null;
  for (const { provider, model } of attempts) {
    try {
      const resp = await callUpstream(provider, model, body, 45000);
      if (resp.ok) {
        return { ok: true, resp, provider, model };
      }
      lastError = `${provider.name}/${model.id}: HTTP ${resp.status}`;
      if (explicit) {
        // 用户显式指定了模型，不做故障转移，把上游错误原样返回
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
    message: `All configured models failed or are unreachable. Last error: ${lastError || "unknown"}`,
  };
}

// 主入口：POST /v1/chat/completions（OpenAI 格式，直接原样透传上游响应，支持流式）
export async function handleChatCompletions(request, env) {
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
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    return errorResponse(result.message, result.status, result.code);
  }

  // 直接把上游响应（含流式 SSE）透传回客户端，附带 CORS 头
  const headers = new Headers(result.resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Upstream-Provider", result.provider.name);
  headers.set("X-Upstream-Model", result.model.id);
  return new Response(result.resp.body, { status: result.resp.status, headers });
}

// 供 admin 面板 "搜索模型" 功能调用：直接用 baseUrl + apiKey 去请求上游的 GET /models
export async function fetchUpstreamModels(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const resp = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    20000
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const list = data.data || data.models || [];
  return list.map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
}
