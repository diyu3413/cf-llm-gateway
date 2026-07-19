import { json, errorResponse, CORS_HEADERS, uuid, generateApiKey, slugify, guessCapabilities } from "./lib/utils.js";
import { getProviders, saveProviders, getSettings, saveSettings, getApiKeys, saveApiKeys } from "./lib/kv.js";
import { requireAdmin, createAdminSession } from "./lib/auth.js";
import { verifyApiKey } from "./lib/auth.js";
import { listModels, handleChatCompletions, fetchUpstreamModels } from "./lib/proxy.js";
import { handleAnthropicMessages, anthropicError } from "./lib/anthropic.js";
import { PROVIDER_PRESETS, findPreset } from "./lib/providers.js";
import { renderAdminPage } from "./admin/html.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ---- 对外 OpenAI 兼容 API ----
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

      // ---- Anthropic Messages API 兼容端点（供 Claude Code 等原生 Anthropic 协议客户端使用）----
      if (path === "/v1/messages" && request.method === "POST") {
        const auth = await verifyApiKey(request, env);
        if (!auth.ok) return anthropicError("Invalid API key", 401, "authentication_error");
        return await handleAnthropicMessages(request, env);
      }

      if (path === "/" || path === "/health") {
        return json({ status: "ok", service: "cf-llm-gateway" });
      }

      // ---- 管理面板页面 ----
      if (path === "/admin" || path === "/admin/") {
        const settings = await getSettings(env);
        return new Response(renderAdminPage(settings.siteTitle), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ---- 管理 API ----
      if (path.startsWith("/admin/api/")) {
        return await handleAdminApi(request, env, path);
      }

      return errorResponse("Not found", 404, "not_found");
    } catch (err) {
      return errorResponse(`Internal error: ${err.message || err}`, 500, "internal_error");
    }
  },
};

async function handleAdminApi(request, env, path) {
  // 登录接口本身不需要鉴权
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
      apikeys: apikeys.filter((k) => !k.revoked).map(({ hash, ...meta }) => meta),
    });
  }

  if (path === "/admin/api/settings" && request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const current = await getSettings(env);
    const updated = { ...current, ...body };
    await saveSettings(env, updated);
    return json({ ok: true, settings: updated });
  }

  // ---- providers ----
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
      models: [],
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
    const merged = ids.map((mid) => existing.get(mid) || { id: mid, enabled: true, capabilities: guessCapabilities(mid) });
    // 保留原有排序，新模型追加在后面
    provider.models = merged;
    if (!provider.defaultModelId && merged.length) provider.defaultModelId = merged[0].id;
    await saveProviders(env, providers);
    return json({ ok: true, models: provider.models });
  }

  // ---- api keys ----
  if (path === "/admin/api/apikeys" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { key, hash, prefix } = await generateApiKey();
    const keys = await getApiKeys(env);
    const meta = { id: uuid(), name: body.name || "", prefix, hash, createdAt: new Date().toISOString(), lastUsedAt: null, revoked: false };
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
