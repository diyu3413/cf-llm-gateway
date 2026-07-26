// KV 存储层。
//
// 省额度的核心策略都在这里：
//  1. 热路径（/v1/*）只读 KV，永不写 KV —— 免费版每天只有 1000 次写。
//  2. 配置在 isolate 内存里缓存 CONFIG_TTL_MS，同一个 isolate 连续处理请求时 0 次 KV 读。
//  3. KV 读带 cacheTtl，边缘再缓存一层。
//  4. 统计只在内存里累加，不落 KV（重启即清零，面板里有说明）。

import { newId } from './crypto.js';

export const CONFIG_KEY = 'gw:config';
export const KEYS_KEY = 'gw:apikeys';

const CONFIG_TTL_MS = 30_000;
const KV_CACHE_TTL = 60; // 秒，KV 边缘缓存

let _configCache = null; // { at, value }
let _keysCache = null;

export const DEFAULT_SETTINGS = {
  strictModelRouting: false, // true = 客户端指定的模型失败后不再降级
  maxAttempts: 6, // 单次请求最多尝试几个模型（免费版每次调用最多 50 个外部子请求）
  headerTimeoutMs: 25_000, // 等待上游响应头的超时
  cooldownSeconds: 180, // 某模型失败后冷却多久不再尝试（内存级）
  rewriteModelName: true, // 把响应里的 model 改回客户端请求的名字
  exposeProviderInList: true, // /v1/models 里附带 owned_by
  allowAnonymousModels: false, // /v1/models 是否允许不带 key 访问
  logErrors: true,
  mapDeveloperRole: true, // 把 role:developer 映射成 system，多数兼容接口不认前者
  peekStreamErrors: true, // 流式响应先看一眼首块，识破 200 但错误藏在流里的情况
  trackUsage: true, // 按网关密钥记调用次数与 token 数
  usageFlushSeconds: 300, // 用量落 KV 的最小间隔，越大越省写额度
};

export const DEFAULT_CONFIG = {
  version: 1,
  providers: [],
  models: [],
  defaultModel: '',
  settings: { ...DEFAULT_SETTINGS },
  updatedAt: 0,
};

function ensureShape(cfg) {
  const out = { ...DEFAULT_CONFIG, ...(cfg || {}) };
  out.providers = Array.isArray(out.providers) ? out.providers : [];
  out.models = Array.isArray(out.models) ? out.models : [];
  out.settings = { ...DEFAULT_SETTINGS, ...(out.settings || {}) };
  return out;
}

export function hasKv(env) {
  return Boolean(env && env.KV && typeof env.KV.get === 'function');
}

export async function loadConfig(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _configCache && now - _configCache.at < CONFIG_TTL_MS) {
    return _configCache.value;
  }
  if (!hasKv(env)) {
    // 没绑 KV 时不至于整个挂掉，但配置无法持久化，面板会红字提示。
    const value = ensureShape(null);
    _configCache = { at: now, value };
    return value;
  }
  let raw = null;
  try {
    raw = await env.KV.get(CONFIG_KEY, { type: 'json', cacheTtl: KV_CACHE_TTL });
  } catch {
    raw = null;
  }
  const value = ensureShape(raw);
  _configCache = { at: now, value };
  return value;
}

export async function saveConfig(env, cfg) {
  if (!hasKv(env)) throw new Error('未绑定 KV 命名空间，无法保存。请在 Worker/Pages 设置里添加名为 KV 的绑定。');
  const value = ensureShape(cfg);
  value.updatedAt = Date.now();
  await env.KV.put(CONFIG_KEY, JSON.stringify(value));
  _configCache = { at: Date.now(), value };
  return value;
}

export async function loadKeys(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _keysCache && now - _keysCache.at < CONFIG_TTL_MS) return _keysCache.value;
  if (!hasKv(env)) {
    const value = [];
    _keysCache = { at: now, value };
    return value;
  }
  let raw = null;
  try {
    raw = await env.KV.get(KEYS_KEY, { type: 'json', cacheTtl: KV_CACHE_TTL });
  } catch {
    raw = null;
  }
  const value = Array.isArray(raw) ? raw : [];
  _keysCache = { at: now, value };
  return value;
}

export async function saveKeys(env, keys) {
  if (!hasKv(env)) throw new Error('未绑定 KV 命名空间，无法保存 API 密钥。');
  const value = Array.isArray(keys) ? keys : [];
  await env.KV.put(KEYS_KEY, JSON.stringify(value));
  _keysCache = { at: Date.now(), value };
  return value;
}

export function invalidateCaches() {
  _configCache = null;
  _keysCache = null;
}

export function makeProviderId() {
  return newId('prov');
}

export function makeModelId() {
  return newId('mdl');
}

export function makeKeyId() {
  return newId('key');
}

// 面板永远拿不到明文上游 key，只能看到掩码。
export function redactProvider(p) {
  const key = p.apiKey || '';
  return {
    ...p,
    apiKey: undefined,
    hasKey: Boolean(key),
    keyMask: key ? key.slice(0, 4) + '****' + key.slice(-4) : '',
  };
}
