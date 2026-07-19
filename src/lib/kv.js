// 对 Workers KV 的读写做了一层内存缓存（同一个 isolate 内有效），
// 目的是尽量减少对 KV 的读请求次数，从而节省 Cloudflare 免费额度。
// 注意：多个 isolate/边缘节点之间缓存不共享，写入后本地立即生效，
// 其他节点最多 CACHE_TTL_MS 后才能看到最新数据，这是用请求数换取的可接受延迟。

const CACHE_TTL_MS = 30_000;

const KEYS = {
  PROVIDERS: "providers",
  SETTINGS: "settings",
  APIKEYS: "apikeys",
};

const memCache = new Map(); // key -> { value, expireAt }

function getCache(key) {
  const hit = memCache.get(key);
  if (hit && hit.expireAt > Date.now()) return hit.value;
  return undefined;
}

function setCache(key, value) {
  memCache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

async function readJson(env, key, fallback) {
  const cached = getCache(key);
  if (cached !== undefined) return cached;
  const raw = await env.KV.get(key);
  const value = raw ? JSON.parse(raw) : fallback;
  setCache(key, value);
  return value;
}

async function writeJson(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
  setCache(key, value); // 本地立即刷新缓存
}

export async function getProviders(env) {
  return readJson(env, KEYS.PROVIDERS, []);
}

export async function saveProviders(env, providers) {
  await writeJson(env, KEYS.PROVIDERS, providers);
}

export async function getSettings(env) {
  return readJson(env, KEYS.SETTINGS, {
    siteTitle: "CF LLM Gateway",
    defaultModel: "auto", // "auto" = 按顺序故障转移；否则为 "providerSlug/modelId"
  });
}

export async function saveSettings(env, settings) {
  await writeJson(env, KEYS.SETTINGS, settings);
}

export async function getApiKeys(env) {
  return readJson(env, KEYS.APIKEYS, []);
}

export async function saveApiKeys(env, keys) {
  await writeJson(env, KEYS.APIKEYS, keys);
}

// 更新某个 key 的 lastUsedAt，做了节流：同一 key 5 分钟内只写一次 KV，
// 避免每次调用 /v1/chat/completions 都触发一次 KV 写请求。
const lastTouch = new Map();
export async function touchApiKeyUsage(env, hash) {
  const now = Date.now();
  const prev = lastTouch.get(hash) || 0;
  if (now - prev < 5 * 60 * 1000) return; // 节流，跳过写入
  lastTouch.set(hash, now);
  const keys = await getApiKeys(env);
  const found = keys.find((k) => k.hash === hash);
  if (found) {
    found.lastUsedAt = new Date().toISOString();
    await saveApiKeys(env, keys);
  }
}
