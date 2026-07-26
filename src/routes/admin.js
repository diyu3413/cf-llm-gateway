// 后台接口。所有路径都在 /admin/api/ 下，除登录外一律要求会话 Cookie。

import { jsonResponse, apiError, preflight, readJsonBody, clientIp } from '../lib/http.js';
import {
  getAdminPassword,
  createSession,
  isAdmin,
  sessionCookieHeader,
  clearCookieHeader,
  checkLoginRate,
  noteLoginFailure,
  clearLoginFailures,
  generateApiKey,
  hashApiKey,
  makeKeyRecord,
} from '../lib/auth.js';
import {
  loadConfig,
  saveConfig,
  loadKeys,
  saveKeys,
  hasKv,
  makeProviderId,
  makeModelId,
  redactProvider,
  DEFAULT_SETTINGS,
} from '../lib/config.js';
import { PROVIDER_PRESETS, findPreset, joinUrl, buildAuthHeaders } from '../lib/presets.js';
import { discoverModels } from '../lib/discovery.js';
import { guessModelMeta, normalizeCaps } from '../lib/caps.js';
import { cooldownSnapshot, clearAllFailures, providerOf } from '../lib/chain.js';
import { runtimeStats } from '../lib/proxy.js';
import { timingSafeEqual } from '../lib/crypto.js';
import { usageSnapshot, resetUsage, flushUsage, maybeFlushUsage } from '../lib/usage.js';
import { disguiseInfo } from '../lib/disguise.js';

export async function handleAdminApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') return preflight();

  const action = url.pathname.replace(/^\/admin\/api\/?/, '');
  const secure = url.protocol === 'https:';

  // ---- 登录/登出 ----
  if (action === 'login') {
    const password = getAdminPassword(env);
    if (!password) {
      return apiError(
        500,
        '还没有设置管理员密码。请在 Worker/Pages 的环境变量里添加纯文本变量 admin_password。',
        'server_error',
        'no_admin_password'
      );
    }
    const ip = clientIp(request);
    const rate = checkLoginRate(ip);
    if (!rate.ok) return apiError(429, '尝试次数过多，请等 10 分钟再试。');
    let body = {};
    try {
      body = await readJsonBody(request);
    } catch {
      body = {};
    }
    if (!timingSafeEqual(String(body.password || ''), password)) {
      noteLoginFailure(ip);
      return apiError(401, '密码不对。', 'authentication_error');
    }
    clearLoginFailures(ip);
    const token = await createSession(env);
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token, secure) } });
  }

  if (action === 'logout') {
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': clearCookieHeader(secure) } });
  }

  if (action === 'session') {
    return jsonResponse({ authed: await isAdmin(request, env), hasPassword: Boolean(getAdminPassword(env)) });
  }

  // ---- 以下全部要登录 ----
  if (!(await isAdmin(request, env))) {
    return apiError(401, '未登录或会话已过期。', 'authentication_error', 'not_authenticated');
  }

  const body = request.method === 'POST' ? await readJsonBody(request).catch(() => ({})) : {};
  const config = await loadConfig(env, { fresh: true });
  maybeFlushUsage(env, ctx, config.settings);

  switch (action) {
    case 'state':
      return stateResponse(env, config);

    case 'usage/reset':
      await resetUsage(env);
      return jsonResponse({ ok: true });

    case 'usage/flush':
      return jsonResponse(await flushUsage(env, { force: true }));

    case 'providers/save':
      return saveProvider(env, config, body);

    case 'providers/delete':
      return deleteProvider(env, config, body);

    case 'providers/discover':
      return discover(env, config, body);

    case 'providers/test':
      return testProvider(env, config, body);

    case 'models/add':
      return addModels(env, config, body);

    case 'models/save':
      return saveModel(env, config, body);

    case 'models/delete':
      return deleteModel(env, config, body);

    case 'models/reorder':
      return reorderModels(env, config, body);

    case 'models/default':
      return setDefaultModel(env, config, body);

    case 'models/test':
      return testModel(env, config, body);

    case 'settings/save':
      return saveSettings(env, config, body);

    case 'keys/create':
      return createKey(env, body);

    case 'keys/delete':
      return deleteKey(env, body);

    case 'keys/toggle':
      return toggleKey(env, body);

    case 'cooldown/clear':
      clearAllFailures();
      return jsonResponse({ ok: true });

    case 'export':
      return exportConfig(env, config);

    case 'import':
      return importConfig(env, body);

    default:
      return apiError(404, '未知的后台接口：' + action);
  }
}

// ---------- 状态 ----------

async function stateResponse(env, config) {
  const keys = await loadKeys(env, { fresh: true });
  const usage = await usageSnapshot(env, keys, config.settings);
  return jsonResponse({
    ok: true,
    kvBound: hasKv(env),
    presets: PROVIDER_PRESETS,
    config: {
      providers: config.providers.map(redactProvider),
      models: config.models,
      defaultModel: config.defaultModel,
      settings: config.settings,
      updatedAt: config.updatedAt,
    },
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      tail: k.tail,
      createdAt: k.createdAt,
      enabled: k.enabled !== false,
    })),
    cooldown: cooldownSnapshot(),
    usage,
    disguise: disguiseInfo(env),
    stats: {
      startedAt: runtimeStats.startedAt,
      requests: runtimeStats.requests,
      success: runtimeStats.success,
      failed: runtimeStats.failed,
      byModel: runtimeStats.byModel,
    },
    defaults: DEFAULT_SETTINGS,
  });
}

// ---------- 提供商 ----------

function sanitizeProviderInput(input, existing) {
  const preset = findPreset(input.type);
  const p = {
    id: existing ? existing.id : makeProviderId(),
    name: String(input.name || (preset && preset.name) || '未命名提供商').slice(0, 60),
    type: String(input.type || 'custom'),
    baseUrl: String(input.baseUrl || (preset && preset.baseUrl) || '').trim(),
    authStyle: input.authStyle || (preset && preset.authStyle) || 'bearer',
    authHeaderName: String(input.authHeaderName || '').trim(),
    authHeaderPrefix: String(input.authHeaderPrefix || '').trim(),
    enabled: input.enabled !== false,
    extraHeaders: input.extraHeaders && typeof input.extraHeaders === 'object' ? input.extraHeaders : {},
    apiKey: existing ? existing.apiKey : '',
    createdAt: existing ? existing.createdAt : Date.now(),
  };
  // 只有真正填了新 key 才覆盖；面板回传掩码时保持原值不动。
  if (typeof input.apiKey === 'string' && input.apiKey && !input.apiKey.includes('****')) {
    p.apiKey = input.apiKey.trim();
  }
  return p;
}

async function saveProvider(env, config, body) {
  const input = body.provider || {};
  if (!input.baseUrl && !findPreset(input.type)) {
    return apiError(400, '请填写 Base URL。');
  }
  const existing = input.id ? config.providers.find((p) => p.id === input.id) : null;
  const provider = sanitizeProviderInput(input, existing);
  if (!provider.baseUrl) return apiError(400, '请填写 Base URL。');
  if (!provider.apiKey) return apiError(400, '请填写 API Key。');

  if (existing) {
    config.providers = config.providers.map((p) => (p.id === provider.id ? provider : p));
  } else {
    config.providers.push(provider);
  }
  await saveConfig(env, config);
  return jsonResponse({ ok: true, provider: redactProvider(provider) });
}

async function deleteProvider(env, config, body) {
  const id = body.id;
  config.providers = config.providers.filter((p) => p.id !== id);
  const removed = config.models.filter((m) => m.providerId === id).map((m) => m.id);
  config.models = config.models.filter((m) => m.providerId !== id);
  if (removed.includes(config.defaultModel)) config.defaultModel = config.models[0] ? config.models[0].id : '';
  await saveConfig(env, config);
  return jsonResponse({ ok: true, removedModels: removed.length });
}

function resolveProviderForProbe(config, body) {
  if (body.id) {
    const p = config.providers.find((x) => x.id === body.id);
    if (!p) return null;
    // 面板里改了 key 但还没保存时，允许用草稿值探测。
    const draft = body.provider || {};
    if (typeof draft.apiKey === 'string' && draft.apiKey && !draft.apiKey.includes('****')) {
      return { ...p, apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl || p.baseUrl, authStyle: draft.authStyle || p.authStyle };
    }
    return p;
  }
  const draft = body.provider || {};
  const preset = findPreset(draft.type);
  return {
    id: 'draft',
    name: draft.name || (preset && preset.name) || 'draft',
    type: draft.type || 'custom',
    baseUrl: String(draft.baseUrl || (preset && preset.baseUrl) || '').trim(),
    apiKey: String(draft.apiKey || '').trim(),
    authStyle: draft.authStyle || (preset && preset.authStyle) || 'bearer',
    authHeaderName: draft.authHeaderName || '',
    authHeaderPrefix: draft.authHeaderPrefix || '',
    extraHeaders: draft.extraHeaders || {},
  };
}

async function discover(env, config, body) {
  const provider = resolveProviderForProbe(config, body);
  if (!provider) return apiError(404, '提供商不存在。');
  if (!provider.baseUrl) return apiError(400, '请先填写 Base URL。');
  if (!provider.apiKey) return apiError(400, '请先填写 API Key。');
  const result = await discoverModels(provider, { timeoutMs: 20000 });
  if (!result.ok) return jsonResponse({ ok: false, message: result.message, status: result.status }, { status: 200 });
  const known = new Set(config.models.filter((m) => m.providerId === provider.id).map((m) => m.model));
  return jsonResponse({
    ok: true,
    count: result.models.length,
    models: result.models.map((m) => ({ ...m, added: known.has(m.id) })),
  });
}

async function testProvider(env, config, body) {
  const provider = resolveProviderForProbe(config, body);
  if (!provider) return apiError(404, '提供商不存在。');
  const started = Date.now();
  const result = await discoverModels(provider, { timeoutMs: 15000 });
  return jsonResponse({
    ok: result.ok,
    ms: Date.now() - started,
    message: result.ok ? '连通，发现 ' + result.models.length + ' 个模型。' : result.message,
  });
}

// ---------- 模型链 ----------

function uniqueAlias(config, wanted, selfId) {
  let alias = wanted;
  let n = 2;
  const taken = (a) => config.models.some((m) => m.id !== selfId && m.alias.toLowerCase() === a.toLowerCase());
  while (taken(alias)) {
    alias = wanted + '-' + n;
    n += 1;
  }
  return alias;
}

async function addModels(env, config, body) {
  const providerId = body.providerId;
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider) return apiError(404, '提供商不存在。');
  const items = Array.isArray(body.models) ? body.models : [];
  if (!items.length) return apiError(400, '没有选择任何模型。');

  let added = 0;
  for (const item of items) {
    const upstream = String(item.id || '').trim();
    if (!upstream) continue;
    if (config.models.some((m) => m.providerId === providerId && m.model === upstream)) continue;
    const meta = guessModelMeta(upstream, provider.type);
    const model = {
      id: makeModelId(),
      providerId,
      model: upstream,
      alias: uniqueAlias(config, String(item.alias || upstream).trim() || upstream, null),
      enabled: true,
      kind: item.kind || meta.kind,
      caps: normalizeCaps(item.caps || meta.caps),
      dropParams: [],
      paramOverrides: {},
      createdAt: Date.now(),
    };
    config.models.push(model);
    added += 1;
  }
  if (!config.defaultModel && config.models.length) {
    const firstChat = config.models.find((m) => m.kind !== 'embedding');
    config.defaultModel = firstChat ? firstChat.id : '';
  }
  await saveConfig(env, config);
  return jsonResponse({ ok: true, added, models: config.models });
}

async function saveModel(env, config, body) {
  const input = body.model || {};
  const existing = config.models.find((m) => m.id === input.id);
  if (!existing) return apiError(404, '模型不存在。');
  const next = {
    ...existing,
    alias: uniqueAlias(config, String(input.alias || existing.alias).trim() || existing.alias, existing.id),
    model: String(input.model || existing.model).trim(),
    enabled: input.enabled !== false,
    kind: input.kind || existing.kind,
    caps: normalizeCaps(input.caps || existing.caps),
    dropParams: Array.isArray(input.dropParams) ? input.dropParams.filter(Boolean).map(String) : existing.dropParams || [],
    paramOverrides:
      input.paramOverrides && typeof input.paramOverrides === 'object' ? input.paramOverrides : existing.paramOverrides || {},
  };
  config.models = config.models.map((m) => (m.id === next.id ? next : m));
  await saveConfig(env, config);
  return jsonResponse({ ok: true, model: next });
}

async function deleteModel(env, config, body) {
  config.models = config.models.filter((m) => m.id !== body.id);
  if (config.defaultModel === body.id) {
    const firstChat = config.models.find((m) => m.kind !== 'embedding' && m.enabled !== false);
    config.defaultModel = firstChat ? firstChat.id : '';
  }
  await saveConfig(env, config);
  return jsonResponse({ ok: true });
}

async function reorderModels(env, config, body) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const map = new Map(config.models.map((m) => [m.id, m]));
  const next = [];
  for (const id of ids) {
    if (map.has(id)) {
      next.push(map.get(id));
      map.delete(id);
    }
  }
  for (const left of map.values()) next.push(left);
  config.models = next;
  await saveConfig(env, config);
  return jsonResponse({ ok: true, models: config.models });
}

async function setDefaultModel(env, config, body) {
  if (body.id && !config.models.some((m) => m.id === body.id)) return apiError(404, '模型不存在。');
  config.defaultModel = body.id || '';
  await saveConfig(env, config);
  return jsonResponse({ ok: true });
}

async function testModel(env, config, body) {
  const model = config.models.find((m) => m.id === body.id);
  if (!model) return apiError(404, '模型不存在。');
  const provider = providerOf(config, model);
  if (!provider) return apiError(404, '模型所属的提供商已被删除。');

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const isEmbedding = model.kind === 'embedding';
    const url = joinUrl(provider.baseUrl, isEmbedding ? 'embeddings' : 'chat/completions');
    const payload = isEmbedding
      ? { model: model.model, input: 'ping' }
      : { model: model.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(provider) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    return jsonResponse({
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      message: res.ok ? '调用成功。' : text.slice(0, 300),
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return jsonResponse({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      message: aborted ? '超时（20s）' : String((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 设置 ----------

async function saveSettings(env, config, body) {
  const s = body.settings || {};
  config.settings = {
    ...config.settings,
    strictModelRouting: Boolean(s.strictModelRouting),
    rewriteModelName: s.rewriteModelName !== false,
    exposeProviderInList: s.exposeProviderInList !== false,
    allowAnonymousModels: Boolean(s.allowAnonymousModels),
    logErrors: s.logErrors !== false,
    mapDeveloperRole: s.mapDeveloperRole !== false,
    peekStreamErrors: s.peekStreamErrors !== false,
    trackUsage: s.trackUsage !== false,
    maxAttempts: clampInt(s.maxAttempts, 1, 20, DEFAULT_SETTINGS.maxAttempts),
    headerTimeoutMs: clampInt(s.headerTimeoutMs, 3000, 120000, DEFAULT_SETTINGS.headerTimeoutMs),
    cooldownSeconds: clampInt(s.cooldownSeconds, 0, 86400, DEFAULT_SETTINGS.cooldownSeconds),
    usageFlushSeconds: clampInt(s.usageFlushSeconds, 30, 86400, DEFAULT_SETTINGS.usageFlushSeconds),
  };
  await saveConfig(env, config);
  return jsonResponse({ ok: true, settings: config.settings });
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------- 网关密钥 ----------

async function createKey(env, body) {
  // 备注必填。用量页是按备注名认人的，一堆"未命名"根本没法管。
  const name = String(body.name || '').trim();
  if (!name) return apiError(400, '请输入密钥备注。');
  const keys = await loadKeys(env, { fresh: true });
  if (keys.length >= 50) return apiError(400, '密钥数量已达上限（50）。');
  const plain = generateApiKey();
  const hash = await hashApiKey(plain);
  const record = makeKeyRecord(name, plain, hash);
  keys.push(record);
  await saveKeys(env, keys);
  // 明文只在这里出现一次，KV 里只有 SHA-256。
  return jsonResponse({
    ok: true,
    key: plain,
    record: { id: record.id, name: record.name, prefix: record.prefix, tail: record.tail, createdAt: record.createdAt, enabled: true },
  });
}

async function deleteKey(env, body) {
  const keys = await loadKeys(env, { fresh: true });
  await saveKeys(env, keys.filter((k) => k.id !== body.id));
  return jsonResponse({ ok: true });
}

async function toggleKey(env, body) {
  const keys = await loadKeys(env, { fresh: true });
  await saveKeys(env, keys.map((k) => (k.id === body.id ? { ...k, enabled: Boolean(body.enabled) } : k)));
  return jsonResponse({ ok: true });
}

// ---------- 导入导出 ----------

async function exportConfig(env, config) {
  return jsonResponse({
    ok: true,
    exportedAt: Date.now(),
    // 上游 key 一并导出，请当作密码文件保管。
    config,
  });
}

async function importConfig(env, body) {
  const incoming = body.config;
  if (!incoming || typeof incoming !== 'object') return apiError(400, '导入内容不是合法配置。');
  const config = {
    version: 1,
    providers: Array.isArray(incoming.providers) ? incoming.providers : [],
    models: Array.isArray(incoming.models) ? incoming.models : [],
    defaultModel: incoming.defaultModel || '',
    settings: { ...DEFAULT_SETTINGS, ...(incoming.settings || {}) },
  };
  await saveConfig(env, config);
  return jsonResponse({ ok: true, providers: config.providers.length, models: config.models.length });
}
