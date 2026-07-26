/**
 * LLM Gateway — OpenAI 兼容的多提供商聚合网关（Cloudflare Worker / Pages）
 * 由 build.mjs 从 src/ 自动生成，不要直接改这个文件。
 * 源码与说明：见仓库 README。MIT License.
 * 生成时间：2026-07-26T09:53:23.944Z
 */

// ---------- src/lib/crypto.js ----------
// 加密相关工具：全部基于 WebCrypto，Workers 原生支持，零依赖。

const TE = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(buf) {
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', TE.encode(input));
  return hex(buf);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', TE.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

async function hmacSign(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, TE.encode(message));
  return b64urlEncode(sig);
}

// 恒定时间比较，避免通过响应耗时侧信道猜测密钥。
function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(len = 40) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function newId(prefix) {
  return prefix + '_' + randomToken(12);
}

// ---------- src/lib/http.js ----------
// 统一的响应构造工具。所有对外错误都套 OpenAI 的 error 结构，
// 这样 Claude Code / AstrBot / Cherry Studio 之类的客户端能正常解析。

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, api-key, anthropic-version, x-requested-with, OpenAI-Organization, OpenAI-Beta',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

function htmlResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // 后台是单文档（CSS/JS 全部内联），一次请求就够，不产生额外静态资源请求。
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(body, { status: init.status || 200, headers });
}

function apiError(status, message, type = 'invalid_request_error', code = null, extra) {
  const body = { error: { message, type, param: null, code } };
  if (extra) body.error.details = extra;
  return jsonResponse(body, { status });
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function readJsonBody(request, limitBytes = 8 * 1024 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limitBytes) throw new Error('请求体过大');
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}

// ---------- src/lib/presets.js ----------
// 提供商预设。baseUrl 均为"OpenAI 兼容"端点，即在其后拼 /chat/completions、/models。
// 注意：厂商随时可能调整地址，面板里所有字段都可手工改，预设只是省事用的。
// authStyle: bearer(默认) | api-key | x-api-key | custom

const PROVIDER_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'bearer',
    region: 'global',
    note: '大陆无法直连，正好由 Cloudflare 中转。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authStyle: 'bearer',
    region: 'cn',
    note: '官方 OpenAI 兼容端点。',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authStyle: 'bearer',
    region: 'global',
    note: 'key 以 nvapi- 开头，/models 可列出上百个模型。',
  },
  {
    id: 'gemini',
    name: 'Google Gemini（OpenAI 兼容层）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authStyle: 'bearer',
    region: 'global',
    note: '走 Google 的 OpenAI 兼容层，不是原生 generateContent。',
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope（国内）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authStyle: 'bearer',
    region: 'cn',
    note: '兼容模式端点。',
  },
  {
    id: 'qwen-intl',
    name: '通义千问 / DashScope（国际）',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    authStyle: 'api-key',
    region: 'cn',
    note: '鉴权用 api-key 请求头，不是 Bearer。',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    authStyle: 'bearer',
    region: 'cn',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authStyle: 'bearer',
    region: 'cn',
  },
  {
    id: 'minimax',
    name: 'MiniMax（国内）',
    baseUrl: 'https://api.minimaxi.com/v1',
    authStyle: 'bearer',
    region: 'cn',
    note: '国内站。它的 OpenAI 兼容接口不认 developer 角色，网关会自动映射成 system。',
  },
  {
    id: 'minimax-intl',
    name: 'MiniMax（国际）',
    baseUrl: 'https://api.minimax.io/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authStyle: 'bearer',
    region: 'cn',
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    authStyle: 'bearer',
    region: 'cn',
  },
  {
    id: 'volcengine',
    name: '火山方舟 Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authStyle: 'bearer',
    region: 'cn',
    note: '模型名要填接入点 ID（ep-...）。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    authStyle: 'bearer',
    region: 'global',
  },
  {
    id: 'anthropic',
    name: 'Anthropic（OpenAI 兼容层）',
    baseUrl: 'https://api.anthropic.com/v1',
    authStyle: 'bearer',
    region: 'global',
    note: '走官方 OpenAI SDK 兼容层。',
  },
  {
    id: 'custom',
    name: '自定义 / 其他',
    baseUrl: '',
    authStyle: 'bearer',
    region: 'global',
    note: '任何 OpenAI 兼容服务都能填，包括自建中转。',
  },
];

function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

// 去掉结尾斜杠再拼接，避免出现 //chat/completions 这种被某些网关 404 的地址。
function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return b + '/' + p;
}

function buildAuthHeaders(provider) {
  const headers = {};
  const key = provider.apiKey || '';
  switch (provider.authStyle) {
    case 'api-key':
      headers['api-key'] = key;
      break;
    case 'x-api-key':
      headers['x-api-key'] = key;
      break;
    case 'custom':
      if (provider.authHeaderName) {
        headers[provider.authHeaderName] = (provider.authHeaderPrefix || '') + key;
      }
      break;
    case 'bearer':
    default:
      headers['Authorization'] = 'Bearer ' + key;
      break;
  }
  if (provider.extraHeaders && typeof provider.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(provider.extraHeaders)) {
      if (k && typeof v === 'string') headers[k] = v;
    }
  }
  return headers;
}

// ---------- src/lib/caps.js ----------
// 能力标注。
// 现实问题：OpenAI 的 /v1/models 只返回 id，几乎没有厂商在里面给出模态信息。
// 所以这里按模型名做启发式猜测，猜完之后面板里可以逐项手工改 —— 手工值优先。

const CAP_KEYS = ['text', 'vision', 'audio', 'video', 'tools', 'json', 'reasoning'];

const has = (s, ...words) => words.some((w) => s.includes(w));

function guessModelMeta(rawId, providerType = '') {
  const id = String(rawId || '').toLowerCase();

  const isEmbedding = has(id, 'embed', 'bge-', 'gte-', 'text-embedding', 'nv-embed', 'm3e');
  const isRerank = has(id, 'rerank', 'reranker');
  const isImageGen = has(id, 'dall-e', 'image-generation', 'flux', 'stable-diffusion', 'sdxl', 'kolors', 'wanx', 'seedream', 'imagen');
  const isTTS = has(id, 'tts', 'speech', 'voice', 'cosyvoice', 'sambert');
  const isASR = has(id, 'whisper', 'asr', 'paraformer', 'sensevoice');
  const isVideoGen = has(id, 'veo', 'sora', 'kling', 'wanx-video', 'seedance');

  let kind = 'chat';
  if (isEmbedding) kind = 'embedding';
  else if (isRerank) kind = 'rerank';
  else if (isImageGen) kind = 'image';
  else if (isVideoGen) kind = 'video';
  else if (isTTS || isASR) kind = 'audio';

  const vision =
    has(id, 'vl', 'vision', 'omni', 'multimodal', 'llava', 'pixtral', 'internvl', 'minicpm-v', 'glm-4v', 'gemini', 'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-6', 'nemotron-vl', 'qvq', 'step-1v', 'mimo-v2.5') &&
    kind === 'chat';

  const audio = (has(id, 'omni', 'audio', 'realtime') || isTTS || isASR) && kind !== 'embedding';
  const video = has(id, 'video', 'veo', 'sora', 'omni-video') || isVideoGen;

  const reasoning = has(id, '-r1', 'r1-', 'reasoner', 'thinking', 'think', 'qwq', 'qvq', 'o1', 'o3', 'o4-mini', 'reason', 'deep-think');

  // 绝大多数 instruct/chat 模型都支持 function calling；base、embedding、语音类不支持。
  const tools = kind === 'chat' && !has(id, '-base', 'base-', 'instruct-base');

  return {
    kind,
    caps: {
      text: kind === 'chat',
      vision,
      audio,
      video,
      tools,
      json: kind === 'chat',
      reasoning,
    },
  };
}

function normalizeCaps(caps) {
  const out = {};
  for (const k of CAP_KEYS) out[k] = Boolean(caps && caps[k]);
  return out;
}

// ---------- src/lib/config.js ----------
// KV 存储层。
//
// 省额度的核心策略都在这里：
//  1. 热路径（/v1/*）只读 KV，永不写 KV —— 免费版每天只有 1000 次写。
//  2. 配置在 isolate 内存里缓存 CONFIG_TTL_MS，同一个 isolate 连续处理请求时 0 次 KV 读。
//  3. KV 读带 cacheTtl，边缘再缓存一层。
//  4. 统计只在内存里累加，不落 KV（重启即清零，面板里有说明）。


const CONFIG_KEY = 'gw:config';
const KEYS_KEY = 'gw:apikeys';

const CONFIG_TTL_MS = 30_000;
const KV_CACHE_TTL = 60; // 秒，KV 边缘缓存

let _configCache = null; // { at, value }
let _keysCache = null;

const DEFAULT_SETTINGS = {
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

const DEFAULT_CONFIG = {
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

function hasKv(env) {
  return Boolean(env && env.KV && typeof env.KV.get === 'function');
}

async function loadConfig(env, { fresh = false } = {}) {
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

async function saveConfig(env, cfg) {
  if (!hasKv(env)) throw new Error('未绑定 KV 命名空间，无法保存。请在 Worker/Pages 设置里添加名为 KV 的绑定。');
  const value = ensureShape(cfg);
  value.updatedAt = Date.now();
  await env.KV.put(CONFIG_KEY, JSON.stringify(value));
  _configCache = { at: Date.now(), value };
  return value;
}

async function loadKeys(env, { fresh = false } = {}) {
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

async function saveKeys(env, keys) {
  if (!hasKv(env)) throw new Error('未绑定 KV 命名空间，无法保存 API 密钥。');
  const value = Array.isArray(keys) ? keys : [];
  await env.KV.put(KEYS_KEY, JSON.stringify(value));
  _keysCache = { at: Date.now(), value };
  return value;
}

function invalidateCaches() {
  _configCache = null;
  _keysCache = null;
}

function makeProviderId() {
  return newId('prov');
}

function makeModelId() {
  return newId('mdl');
}

function makeKeyId() {
  return newId('key');
}

// 面板永远拿不到明文上游 key，只能看到掩码。
function redactProvider(p) {
  const key = p.apiKey || '';
  return {
    ...p,
    apiKey: undefined,
    hasKey: Boolean(key),
    keyMask: key ? key.slice(0, 4) + '****' + key.slice(-4) : '',
  };
}

// ---------- src/lib/usage.js ----------
// 按网关密钥统计调用次数与 token 数。
//
// 免费版 KV 每天只有 1000 次写，所以绝对不能每次调用写一次：
//  1. 计数先在 isolate 内存里累加（delta）；
//  2. 每隔 usageFlushSeconds（默认 300s）才把 delta 合并进 KV 里的基线；
//     最坏情况一天 288 次写，额度用不到三成。
//  3. 面板读的是「KV 基线 + 内存 delta」，所以显示的数字始终是最新的。
//
// token 数优先用上游返回的 usage 字段；上游没给（多数流式接口默认不带）时，
// 用和 /v1/messages/count_tokens 同一套算法估算，并单独记一个 estimatedCalls，
// 免得把估算值当成账单依据。


const USAGE_KEY = 'gw:usage';

const BASE_TTL_MS = 30_000;
const MAX_MODELS_PER_KEY = 40;
const MIN_FLUSH_SECONDS = 30;
const DEFAULT_FLUSH_SECONDS = 300;

let delta = Object.create(null);
let deltaEvents = 0;
let lastFlushAt = 0;
let baseCache = null; // { at, value }

function blank() {
  return {
    calls: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    estimatedCalls: 0,
    lastAt: 0,
    name: '',
    byModel: Object.create(null),
    byEndpoint: Object.create(null),
  };
}

// ---------- token 估算 ----------

// CJK 统一表意文字、假名、谚文、全角符号：这些在主流分词器里大约 1.5 字/token；
// 其余按经典的 4 字符/token 算。用正则一次性数出来，避免逐字符循环吃满 CPU 配额。
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/g;
const ESTIMATE_CHAR_CAP = 400_000;

function countCjk(str) {
  const m = String(str || '').match(CJK_RE);
  return m ? m.length : 0;
}

function estimateFromCounts(chars, cjk) {
  const c = Math.max(0, Number(chars) || 0);
  const k = Math.min(c, Math.max(0, Number(cjk) || 0));
  return Math.ceil(k / 1.5 + (c - k) / 4);
}

function estimateTokens(input) {
  if (!input) return 0;
  let str = typeof input === 'string' ? input : JSON.stringify(input);
  if (!str) return 0;
  if (str.length > ESTIMATE_CHAR_CAP) str = str.slice(0, ESTIMATE_CHAR_CAP);
  return estimateFromCounts(str.length, countCjk(str));
}

// ---------- 记账 ----------

function recordUsage(entry) {
  if (!entry || !entry.keyId) return;
  const rec = delta[entry.keyId] || (delta[entry.keyId] = blank());
  const p = Math.max(0, Math.round(Number(entry.prompt) || 0));
  const c = Math.max(0, Math.round(Number(entry.completion) || 0));

  rec.calls += 1;
  rec.prompt += p;
  rec.completion += c;
  rec.total += p + c;
  if (entry.estimated) rec.estimatedCalls += 1;
  rec.lastAt = Date.now();
  if (entry.name) rec.name = String(entry.name).slice(0, 60);

  if (entry.model) {
    const key = String(entry.model).slice(0, 80);
    const m = rec.byModel[key] || (rec.byModel[key] = { calls: 0, tokens: 0 });
    m.calls += 1;
    m.tokens += p + c;
  }
  const ep = String(entry.endpoint || 'chat').slice(0, 32);
  const e = rec.byEndpoint[ep] || (rec.byEndpoint[ep] = { calls: 0 });
  e.calls += 1;

  deltaEvents += 1;
}

function pendingUsageEvents() {
  return deltaEvents;
}

// ---------- 合并与裁剪 ----------

function mergeInto(target, src) {
  for (const id of Object.keys(src || {})) {
    const r = src[id];
    const t = target[id] || (target[id] = blank());
    t.calls += r.calls || 0;
    t.prompt += r.prompt || 0;
    t.completion += r.completion || 0;
    t.total += r.total || 0;
    t.estimatedCalls += r.estimatedCalls || 0;
    t.lastAt = Math.max(t.lastAt || 0, r.lastAt || 0);
    if (r.name) t.name = r.name;
    for (const k of Object.keys(r.byModel || {})) {
      const x = t.byModel[k] || (t.byModel[k] = { calls: 0, tokens: 0 });
      x.calls += r.byModel[k].calls || 0;
      x.tokens += r.byModel[k].tokens || 0;
    }
    for (const k of Object.keys(r.byEndpoint || {})) {
      const x = t.byEndpoint[k] || (t.byEndpoint[k] = { calls: 0 });
      x.calls += r.byEndpoint[k].calls || 0;
    }
  }
  return target;
}

function cloneKeys(src) {
  const out = Object.create(null);
  for (const id of Object.keys(src || {})) {
    const r = src[id];
    out[id] = {
      calls: r.calls || 0,
      prompt: r.prompt || 0,
      completion: r.completion || 0,
      total: r.total || 0,
      estimatedCalls: r.estimatedCalls || 0,
      lastAt: r.lastAt || 0,
      name: r.name || '',
      byModel: { ...(r.byModel || {}) },
      byEndpoint: { ...(r.byEndpoint || {}) },
    };
  }
  return out;
}

// KV 单值有大小上限，模型多了别让它无限膨胀：每把 key 只留调用最多的前 N 个模型。
function trimAll(keys) {
  for (const id of Object.keys(keys)) {
    const bm = keys[id].byModel || {};
    const names = Object.keys(bm);
    if (names.length <= MAX_MODELS_PER_KEY) continue;
    names.sort((a, b) => (bm[b].calls || 0) - (bm[a].calls || 0));
    const kept = Object.create(null);
    for (const n of names.slice(0, MAX_MODELS_PER_KEY)) kept[n] = bm[n];
    keys[id].byModel = kept;
  }
  return keys;
}

// ---------- KV ----------

async function loadBase(env, fresh) {
  const now = Date.now();
  if (!fresh && baseCache && now - baseCache.at < BASE_TTL_MS) return baseCache.value;
  if (!hasKv(env)) {
    const value = { updatedAt: 0, keys: Object.create(null) };
    baseCache = { at: now, value };
    return value;
  }
  let raw = null;
  try {
    raw = await env.KV.get(USAGE_KEY, { type: 'json', cacheTtl: 60 });
  } catch {
    raw = null;
  }
  const value = {
    updatedAt: (raw && raw.updatedAt) || 0,
    keys: raw && raw.keys && typeof raw.keys === 'object' ? raw.keys : Object.create(null),
  };
  baseCache = { at: now, value };
  return value;
}

async function flushUsage(env, { force = false, intervalSeconds = DEFAULT_FLUSH_SECONDS } = {}) {
  if (!deltaEvents) return { flushed: false, reason: 'empty' };
  if (!hasKv(env)) return { flushed: false, reason: 'no_kv' };
  const now = Date.now();
  const wait = Math.max(MIN_FLUSH_SECONDS, Number(intervalSeconds) || DEFAULT_FLUSH_SECONDS) * 1000;
  if (!force && now - lastFlushAt < wait) return { flushed: false, reason: 'too_soon' };

  // 先摘走 delta，写 KV 期间新来的调用会落进新的 delta，不会丢也不会重复计。
  const pending = delta;
  const count = deltaEvents;
  delta = Object.create(null);
  deltaEvents = 0;
  lastFlushAt = now;

  try {
    const base = await loadBase(env, true);
    const merged = trimAll(mergeInto(cloneKeys(base.keys), pending));
    const value = { updatedAt: now, keys: merged };
    await env.KV.put(USAGE_KEY, JSON.stringify(value));
    baseCache = { at: now, value };
    return { flushed: true, events: count };
  } catch (err) {
    // 写失败就把这批还回去，下个周期重试，不至于把统计吞掉。
    mergeInto(delta, pending);
    deltaEvents += count;
    return { flushed: false, reason: 'error', error: String((err && err.message) || err) };
  }
}

function maybeFlushUsage(env, ctx, settings) {
  if (!deltaEvents) return;
  if (settings && settings.trackUsage === false) return;
  const interval = Math.max(
    MIN_FLUSH_SECONDS,
    Number(settings && settings.usageFlushSeconds) || DEFAULT_FLUSH_SECONDS
  );
  if (Date.now() - lastFlushAt < interval * 1000) return;
  const p = flushUsage(env, { intervalSeconds: interval }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

async function resetUsage(env) {
  delta = Object.create(null);
  deltaEvents = 0;
  lastFlushAt = Date.now();
  const value = { updatedAt: Date.now(), keys: Object.create(null) };
  baseCache = { at: Date.now(), value };
  if (hasKv(env)) {
    try {
      await env.KV.delete(USAGE_KEY);
    } catch {
      /* 删不掉就等下次覆盖写 */
    }
  }
  return { ok: true };
}

/** 面板用：KV 基线 + 内存 delta，再和当前密钥列表对齐。 */
async function usageSnapshot(env, keyRecords, settings) {
  const base = await loadBase(env, true);
  const merged = mergeInto(cloneKeys(base.keys), delta);
  const known = new Map((keyRecords || []).map((k) => [k.id, k]));

  const rows = [];
  for (const id of Object.keys(merged)) {
    const r = merged[id];
    const k = known.get(id);
    rows.push({
      id,
      name: (k && k.name) || r.name || '已删除的密钥',
      prefix: k ? k.prefix : '',
      tail: k ? k.tail : '',
      exists: Boolean(k),
      calls: r.calls,
      prompt: r.prompt,
      completion: r.completion,
      total: r.total,
      estimatedCalls: r.estimatedCalls,
      lastAt: r.lastAt,
      byModel: Object.keys(r.byModel || {})
        .map((n) => ({ name: n, calls: r.byModel[n].calls || 0, tokens: r.byModel[n].tokens || 0 }))
        .sort((a, b) => b.calls - a.calls),
      byEndpoint: Object.keys(r.byEndpoint || {})
        .map((n) => ({ name: n, calls: r.byEndpoint[n].calls || 0 }))
        .sort((a, b) => b.calls - a.calls),
    });
  }
  // 还没被调用过的密钥也列出来，省得用户以为漏了
  for (const k of keyRecords || []) {
    if (merged[k.id]) continue;
    rows.push({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      tail: k.tail,
      exists: true,
      calls: 0,
      prompt: 0,
      completion: 0,
      total: 0,
      estimatedCalls: 0,
      lastAt: 0,
      byModel: [],
      byEndpoint: [],
    });
  }
  rows.sort((a, b) => b.calls - a.calls || b.total - a.total);

  const totals = rows.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.prompt += r.prompt;
      acc.completion += r.completion;
      acc.total += r.total;
      acc.estimatedCalls += r.estimatedCalls;
      return acc;
    },
    { calls: 0, prompt: 0, completion: 0, total: 0, estimatedCalls: 0 }
  );

  return {
    keys: rows,
    totals,
    persisted: hasKv(env) && (!settings || settings.trackUsage !== false),
    tracking: !settings || settings.trackUsage !== false,
    flushSeconds: Math.max(MIN_FLUSH_SECONDS, Number(settings && settings.usageFlushSeconds) || DEFAULT_FLUSH_SECONDS),
    updatedAt: base.updatedAt,
    pending: deltaEvents,
  };
}

// ---------- 响应体计量 ----------

function numOr(a, b) {
  const x = Number(a);
  if (Number.isFinite(x) && x > 0) return x;
  const y = Number(b);
  return Number.isFinite(y) && y > 0 ? y : 0;
}

function usageFromJson(obj) {
  const u = obj && obj.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = numOr(u.prompt_tokens, u.input_tokens);
  const completion = numOr(u.completion_tokens, u.output_tokens);
  if (!prompt && !completion) return null;
  return { prompt, completion };
}

function usageFromLine(line) {
  const s = String(line || '').trim();
  if (!s || s.indexOf('"usage"') < 0) return null;
  const payload = s.startsWith('data:') ? s.slice(5).trim() : s;
  if (!payload || payload === '[DONE]') return null;
  try {
    return usageFromJson(JSON.parse(payload));
  } catch {
    return null;
  }
}

function jsonContent(obj) {
  let text = '';
  const choices = obj && obj.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const msg = (c && (c.message || c.delta)) || {};
      if (typeof msg.content === 'string') text += msg.content;
      if (typeof msg.reasoning_content === 'string') text += msg.reasoning_content;
      if (typeof c.text === 'string') text += c.text;
    }
  }
  return text;
}

/**
 * 把上游响应体原样透传，同时顺手把 usage / 输出字符数数出来。
 * 不缓冲、不改内容，chunk 进来就 enqueue 出去，流式体验完全不受影响。
 */
function meterBody(readable, { stream, onDone }) {
  const dec = new TextDecoder();
  const CONTENT_RE = /"(?:content|text|reasoning_content)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let usage = null;
  let outChars = 0;
  let outCjk = 0;
  let buf = '';

  function handleLine(line) {
    if (!line) return;
    const u = usageFromLine(line);
    if (u) usage = u;
    CONTENT_RE.lastIndex = 0;
    let m;
    while ((m = CONTENT_RE.exec(line))) {
      const t = m[1];
      outChars += t.length;
      outCjk += countCjk(t);
    }
  }

  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          buf += dec.decode(chunk, { stream: true });
          if (!stream) {
            // 非流式响应体通常几 KB，整体攒起来最后一次 JSON.parse 最准。
            // 万一遇到超大响应（比如一次要几千条 embedding），改成只留尾部窗口：
            // OpenAI 格式里 usage 在 JSON 末尾，留尾巴仍然能扫到，也不会把内存和 CPU 吃穿。
            if (buf.length > 1_048_576) buf = buf.slice(-262_144);
            return;
          }
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            handleLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
          // 上游一直不发换行时别让缓冲无限涨
          if (buf.length > 262_144) {
            handleLine(buf);
            buf = '';
          }
        } catch {
          /* 计量出错绝不能影响转发 */
        }
      },
      flush() {
        try {
          buf += dec.decode();
          if (stream) {
            handleLine(buf);
          } else {
            let parsed = null;
            try {
              parsed = JSON.parse(buf);
            } catch {
              parsed = null;
            }
            if (parsed) {
              usage = usageFromJson(parsed);
              const t = jsonContent(parsed);
              outChars = t.length;
              outCjk = countCjk(t);
            } else {
              handleLine(buf);
            }
          }
          onDone({ usage, outChars, outCjk });
        } catch {
          /* 同上 */
        }
      },
    })
  );
}

// ---------- src/lib/disguise.js ----------
// 首页伪装。
//
// 环境变量 url 指定一个域名，访问网关根路径 / 时直接把那个站点的首页吐回去，
// 从外面看不出这是个 LLM 网关。控制台仍然在 /admin，接口仍然在 /v1/*。
//
// 几个设计取舍：
//  - 只代理根路径这一个页面，不做通用反代 —— Cloudflare 服务条款不允许把 Workers 当开放代理。
//  - 注入 <base href="目标站点/">，页面里的图片/CSS/JS 由浏览器直接去目标站点取，
//    不经过 Worker，所以伪装本身只花 1 次请求，不会拖累免费额度。
//  - 回源结果走边缘缓存（cacheTtl 30 分钟），对外再挂 10 分钟 Cache-Control，
//    重复访问大多命中缓存，连 Worker 都不用醒。
//  - 一律不透传目标站点的 Set-Cookie 和 CSP，避免把别人的 cookie 写到你的域名下。

const OFF_VALUES = new Set(['off', 'none', 'no', 'false', '0', 'self', 'local', 'landing', 'disable', 'disabled']);
const DEFAULT_TARGET = 'https://www.bing.com/';

/** 返回要伪装的目标 URL；返回 null 表示关闭伪装、显示网关自带落地页。 */
function disguiseTarget(env) {
  const raw = String((env && (env.url || env.URL || env.DISGUISE_URL)) || '').trim();
  if (!raw) return DEFAULT_TARGET; // 没设就默认伪装成 bing
  if (OFF_VALUES.has(raw.toLowerCase())) return null;

  let s = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_TARGET;
    return u.toString();
  } catch {
    return DEFAULT_TARGET;
  }
}

function disguiseInfo(env) {
  const target = disguiseTarget(env);
  return {
    enabled: Boolean(target),
    target: target || '',
    fromDefault: !String((env && (env.url || env.URL || env.DISGUISE_URL)) || '').trim(),
  };
}

function injectBase(html, baseHref) {
  // 先干掉页面自带的 base，免得两条 base 打架（浏览器只认第一条）
  let out = String(html).replace(/<base\b[^>]*>/gi, '');
  const tag = '<base href="' + baseHref + '">';
  const head = out.match(/<head[^>]*>/i);
  if (head) return out.replace(head[0], head[0] + tag);
  const htmlTag = out.match(/<html[^>]*>/i);
  if (htmlTag) return out.replace(htmlTag[0], htmlTag[0] + '<head>' + tag + '</head>');
  return tag + out;
}

function neutralPage(hostname) {
  // 回源失败时的兜底：一个不带任何网关痕迹的空页面。
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + String(hostname || '').replace(/[<>&"]/g, '') + '</title></head><body></body></html>'
  );
}

/** 伪装页面的 404：不暴露任何网关信息。 */
function neutralNotFound() {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head>' +
      '<body><h1>404 Not Found</h1></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
  );
}

async function serveDisguise(target, request) {
  const method = (request && request.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  let origin = '';
  let hostname = '';
  try {
    const u = new URL(target);
    origin = u.origin;
    hostname = u.hostname;
  } catch {
    return new Response(neutralPage(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const headers = new Headers({
    'Cache-Control': 'public, max-age=600',
    'X-Robots-Tag': 'noindex, nofollow',
  });

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': (request && request.headers.get('user-agent')) || 'Mozilla/5.0',
        Accept: (request && request.headers.get('accept')) || 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': (request && request.headers.get('accept-language')) || 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      cf: { cacheTtl: 1800, cacheEverything: true },
    });

    const ct = upstream.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) {
      headers.set('Content-Type', ct || 'application/octet-stream');
      return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
    }

    const html = await upstream.text();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(method === 'HEAD' ? null : injectBase(html, origin + '/'), { status: 200, headers });
  } catch {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(method === 'HEAD' ? null : neutralPage(hostname), { status: 200, headers });
  }
}

// ---------- src/lib/auth.js ----------
// 鉴权：
//  - 管理员：环境变量 admin_password（纯文本），登录后签发 HMAC 签名的会话 Cookie。
//  - 网关 key：随机生成，KV 里只存 SHA-256，明文只在创建时返回一次。


const SESSION_COOKIE = 'gw_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 登录限速：纯内存，不占 KV 写额度。isolate 重启会清零，够挡脚本爆破。
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 8;

function getAdminPassword(env) {
  return env.admin_password || env.ADMIN_PASSWORD || '';
}

function sessionSecret(env) {
  return 'gw|' + getAdminPassword(env) + '|' + (env.SESSION_SALT || 'default-salt');
}

function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.at > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { at: now, n: 0 });
    return { ok: true, remaining: LOGIN_MAX };
  }
  if (rec.n >= LOGIN_MAX) return { ok: false, remaining: 0 };
  return { ok: true, remaining: LOGIN_MAX - rec.n };
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.at > LOGIN_WINDOW_MS) loginAttempts.set(ip, { at: now, n: 1 });
  else rec.n += 1;
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

async function createSession(env) {
  const payload = { exp: Date.now() + SESSION_TTL_MS, n: randomToken(8) };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(sessionSecret(env), body);
  return body + '.' + sig;
}

async function verifySessionToken(env, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  let expected;
  try {
    expected = await hmacSign(sessionSecret(env), body);
  } catch {
    return false;
  }
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookieHeader(token, secure) {
  const attrs = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookieHeader(secure) {
  const attrs = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

async function isAdmin(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  return verifySessionToken(env, token);
}

// ---------- 网关自签发的 API key ----------

function generateApiKey() {
  return 'sk-gw-' + randomToken(44);
}

async function hashApiKey(key) {
  return sha256Hex('gwkey|' + key);
}

function extractBearer(request) {
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const xkey = request.headers.get('x-api-key') || request.headers.get('api-key');
  if (xkey) return xkey.trim();
  return '';
}

async function verifyGatewayKey(request, env) {
  const presented = extractBearer(request);
  if (!presented) return { ok: false, reason: 'missing' };
  const keys = await loadKeys(env);
  if (!keys.length) return { ok: false, reason: 'no_keys' };
  const hash = await hashApiKey(presented);
  for (const k of keys) {
    if (k.enabled !== false && timingSafeEqual(k.hash, hash)) {
      return { ok: true, key: k };
    }
  }
  return { ok: false, reason: 'invalid' };
}

function makeKeyRecord(name, plain, hash) {
  return {
    id: newId('key'),
    name: name || '未命名',
    hash,
    prefix: plain.slice(0, 12),
    tail: plain.slice(-4),
    createdAt: Date.now(),
    enabled: true,
  };
}

const SESSION_COOKIE_NAME = SESSION_COOKIE;

// ---------- src/lib/discovery.js ----------
// 模型搜索：拿 provider 的 key 去打上游 /models，把能用的模型列出来。
// 一次搜索 = 1 个外部子请求，不算 Worker 请求数。


function normalizeModelList(payload) {
  let arr = [];
  if (Array.isArray(payload)) arr = payload;
  else if (payload && Array.isArray(payload.data)) arr = payload.data;
  else if (payload && Array.isArray(payload.models)) arr = payload.models;
  else if (payload && payload.data && Array.isArray(payload.data.models)) arr = payload.data.models;

  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const id =
      typeof item === 'string'
        ? item
        : item && (item.id || item.model || item.name || item.model_name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: String(id),
      ownedBy: (item && (item.owned_by || item.owner)) || '',
      raw: item && typeof item === 'object' ? { created: item.created } : {},
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function discoverModels(provider, { timeoutMs = 20000 } = {}) {
  const url = joinUrl(provider.baseUrl, 'models');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...buildAuthHeaders(provider) },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: '上游 ' + res.status + '：' + text.slice(0, 300),
        models: [],
      };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, message: '上游返回的不是 JSON，检查 Base URL 是否指向 OpenAI 兼容端点。', models: [] };
    }
    const list = normalizeModelList(payload).map((m) => {
      const meta = guessModelMeta(m.id, provider.type);
      return { id: m.id, ownedBy: m.ownedBy, kind: meta.kind, caps: meta.caps };
    });
    if (!list.length) {
      return { ok: false, status: res.status, message: '接口通了，但没解析出模型列表。可以手工填模型名。', models: [] };
    }
    return { ok: true, status: res.status, models: list };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      ok: false,
      status: 0,
      message: aborted ? '连接超时（' + timeoutMs + 'ms）' : '连接失败：' + (err && err.message ? err.message : String(err)),
      models: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- src/lib/chain.js ----------
// 逐层调用链。
//
// 需求：按添加顺序从上往下试，第一个能通的就用它，之后不再往后试；全挂返回 403。
//
// 实现要点：不做"先探活再调用"那种两段式 —— 那会让每个模型消耗两个子请求。
// 直接发真实请求，收到非 2xx 或网络异常就顺延到下一个，这本身就是最准确的连通性判定。
// 失败的模型进内存冷却表，冷却期内直接跳过，连子请求都不发。

const cooldown = new Map(); // modelId -> { until, status, message }

function isCoolingDown(modelId) {
  const rec = cooldown.get(modelId);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    cooldown.delete(modelId);
    return false;
  }
  return true;
}

function getCooldown(modelId) {
  const rec = cooldown.get(modelId);
  if (!rec || Date.now() > rec.until) return null;
  return rec;
}

function markFailure(modelId, seconds, status, message) {
  if (!seconds || seconds <= 0) return;
  cooldown.set(modelId, {
    until: Date.now() + seconds * 1000,
    status: status || 0,
    message: String(message || '').slice(0, 200),
    at: Date.now(),
  });
}

function clearFailure(modelId) {
  cooldown.delete(modelId);
}

function clearAllFailures() {
  cooldown.clear();
}

function cooldownSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [id, rec] of cooldown.entries()) {
    if (rec.until > now) out.push({ modelId: id, secondsLeft: Math.ceil((rec.until - now) / 1000), status: rec.status, message: rec.message });
  }
  return out;
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

function findModelByName(config, name) {
  const want = normalizeName(name);
  if (!want) return null;
  const enabled = config.models.filter((m) => m.enabled !== false);
  // 依次按 别名 -> 上游模型名 -> 内部 id 匹配
  return (
    enabled.find((m) => normalizeName(m.alias) === want) ||
    enabled.find((m) => normalizeName(m.model) === want) ||
    enabled.find((m) => normalizeName(m.id) === want) ||
    null
  );
}

const AUTO_NAMES = new Set(['', 'auto', 'default', 'gateway', 'gw', 'any']);

/**
 * 生成本次请求要依次尝试的模型队列。
 * 规则：
 *  - 客户端点名了某个模型 -> 该模型排第一，其余按配置顺序跟在后面（严格模式下只留它）。
 *  - 没点名 / 点了不存在的名字 -> 默认模型排第一，其余按配置顺序。
 *  - 冷却中的模型排到最后（而不是直接删掉），避免全部冷却时无路可走。
 */
function buildCandidates(config, requestedModel, opts = {}) {
  const wantEmbedding = Boolean(opts.embedding);
  const enabled = config.models.filter(
    (m) => m.enabled !== false && (wantEmbedding ? m.kind === 'embedding' : m.kind !== 'embedding')
  );
  if (!enabled.length) return { list: [], matched: null, unknownModel: false };

  const asked = normalizeName(requestedModel);
  const isAuto = AUTO_NAMES.has(asked);
  const matched = isAuto ? null : findModelByName(config, requestedModel);
  const unknownModel = !isAuto && !matched;

  let head = null;
  if (matched) head = matched;
  else if (config.defaultModel) head = enabled.find((m) => m.id === config.defaultModel) || null;

  let ordered = [];
  if (head) ordered.push(head);
  for (const m of enabled) {
    if (!head || m.id !== head.id) ordered.push(m);
  }

  if (matched && config.settings.strictModelRouting) ordered = [matched];

  const hot = ordered.filter((m) => !isCoolingDown(m.id));
  const cold = ordered.filter((m) => isCoolingDown(m.id));
  const list = hot.concat(cold);

  const max = Math.max(1, Number(config.settings.maxAttempts) || 6);
  return { list: list.slice(0, max), matched, unknownModel, total: ordered.length };
}

function providerOf(config, model) {
  return config.providers.find((p) => p.id === model.providerId) || null;
}

// ---------- src/lib/proxy.js ----------
// 转发核心。


// 内存级统计，仅用于面板展示，不写 KV。
const runtimeStats = {
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
function accountCall({ config, auth, model, endpoint, body, usage, outChars, outCjk, ok = true }) {
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
async function runChain({ env, config, body, path, embedding = false }) {
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

function chainFailureResponse(result) {
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

function gatewayHeaders(result, requestId) {
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
async function proxyOpenAI({ env, config, path, body, requestId, embedding = false, auth = null }) {
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

function buildModelList(config, { includeOwner = true } = {}) {
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

// ---------- src/ui/css.js ----------
// Material Design 3 样式表。
// 色板取 M3 的 teal 基线方案（种子 #006874），亮暗两套 tonal palette 全量映射到
// md-sys-color-* 变量；形状用 M3 shape scale（4/8/12/16/28），排版用 M3 type scale，
// 动效用 M3 motion 的 emphasized / standard 曲线。
// 全部内联进 HTML，后台整页只消耗 1 次 Worker 请求。
//
// 断点（移动端以 375px 为基准设计）：
//   <=840px  侧栏收进模态抽屉，顶栏出现汉堡按钮
//   <=600px  列表项纵向堆叠、按钮整行、对话框贴边

const UI_CSS = `
:root{
  --md-sys-color-primary:#006874;
  --md-sys-color-on-primary:#ffffff;
  --md-sys-color-primary-container:#9eeffd;
  --md-sys-color-on-primary-container:#001f24;
  --md-sys-color-secondary:#4a6267;
  --md-sys-color-on-secondary:#ffffff;
  --md-sys-color-secondary-container:#cde7ec;
  --md-sys-color-on-secondary-container:#051f23;
  --md-sys-color-tertiary:#525e7d;
  --md-sys-color-on-tertiary:#ffffff;
  --md-sys-color-tertiary-container:#dae2ff;
  --md-sys-color-on-tertiary-container:#0e1b37;
  --md-sys-color-error:#ba1a1a;
  --md-sys-color-on-error:#ffffff;
  --md-sys-color-error-container:#ffdad6;
  --md-sys-color-on-error-container:#410002;
  --md-sys-color-surface:#f5fafb;
  --md-sys-color-on-surface:#171d1e;
  --md-sys-color-surface-variant:#dbe4e6;
  --md-sys-color-on-surface-variant:#3f484a;
  --md-sys-color-surface-container-lowest:#ffffff;
  --md-sys-color-surface-container-low:#eff5f6;
  --md-sys-color-surface-container:#e9eff0;
  --md-sys-color-surface-container-high:#e3e9ea;
  --md-sys-color-surface-container-highest:#dee3e5;
  --md-sys-color-outline:#6f797a;
  --md-sys-color-outline-variant:#bfc8ca;
  --md-sys-color-inverse-surface:#2b3133;
  --md-sys-color-inverse-on-surface:#ecf2f3;
  --md-sys-color-scrim:rgba(0,0,0,.4);
  --md-sys-color-success:#2c6a43;
  --md-sys-color-on-success-container:#00210f;
  --md-sys-color-success-container:#b0f1c2;
  --md-elev-1:0 1px 2px rgba(0,0,0,.30),0 1px 3px 1px rgba(0,0,0,.15);
  --md-elev-2:0 1px 2px rgba(0,0,0,.30),0 2px 6px 2px rgba(0,0,0,.15);
  --md-elev-3:0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.30);
  /* M3 motion：emphasized 用于进出场，standard 用于状态变化 */
  --ease-emph:cubic-bezier(.2,0,0,1);
  --ease-emph-out:cubic-bezier(.05,.7,.1,1);
  --ease-std:cubic-bezier(.2,0,0,1);
  --dur-s:150ms;
  --dur-m:250ms;
  --dur-l:400ms;
  color-scheme:light;
}
[data-theme=dark]{
  --md-sys-color-primary:#82d3e0;
  --md-sys-color-on-primary:#00363d;
  --md-sys-color-primary-container:#004f58;
  --md-sys-color-on-primary-container:#9eeffd;
  --md-sys-color-secondary:#b1cbd0;
  --md-sys-color-on-secondary:#1c3438;
  --md-sys-color-secondary-container:#334b4f;
  --md-sys-color-on-secondary-container:#cde7ec;
  --md-sys-color-tertiary:#bac6ea;
  --md-sys-color-on-tertiary:#24304d;
  --md-sys-color-tertiary-container:#3b4664;
  --md-sys-color-on-tertiary-container:#dae2ff;
  --md-sys-color-error:#ffb4ab;
  --md-sys-color-on-error:#690005;
  --md-sys-color-error-container:#93000a;
  --md-sys-color-on-error-container:#ffdad6;
  --md-sys-color-surface:#0e1415;
  --md-sys-color-on-surface:#dee3e5;
  --md-sys-color-surface-variant:#3f484a;
  --md-sys-color-on-surface-variant:#bfc8ca;
  --md-sys-color-surface-container-lowest:#090f10;
  --md-sys-color-surface-container-low:#171d1e;
  --md-sys-color-surface-container:#1b2122;
  --md-sys-color-surface-container-high:#262b2c;
  --md-sys-color-surface-container-highest:#303637;
  --md-sys-color-outline:#899294;
  --md-sys-color-outline-variant:#3f484a;
  --md-sys-color-inverse-surface:#dee3e5;
  --md-sys-color-inverse-on-surface:#2b3133;
  --md-sys-color-success:#94d5a8;
  --md-sys-color-success-container:#0c4d2b;
  --md-sys-color-on-success-container:#b0f1c2;
  color-scheme:dark;
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:Roboto,"Roboto Flex","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
  background:var(--md-sys-color-surface);
  color:var(--md-sys-color-on-surface);
  font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
  -webkit-tap-highlight-color:transparent;
  overflow-wrap:anywhere;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
}
body.nav-open{overflow:hidden}
:focus-visible{outline:3px solid var(--md-sys-color-primary);outline-offset:2px;border-radius:4px}
svg.i{width:22px;height:22px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
svg.i.sm{width:18px;height:18px;stroke-width:2}

/* ---------- 动效关键帧 ---------- */
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes dlgIn{from{opacity:0;transform:translateY(28px) scale(.94)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes popIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
}

/* ---------- 排版 M3 type scale ---------- */
.display-s{font-size:36px;line-height:44px;font-weight:400;letter-spacing:0}
.headline-s{font-size:24px;line-height:32px;font-weight:400;margin:0}
.title-l{font-size:22px;line-height:28px;font-weight:400;margin:0}
.title-m{font-size:16px;line-height:24px;font-weight:500;letter-spacing:.15px;margin:0}
.title-s{font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;margin:0}
.body-m{font-size:14px;line-height:20px;letter-spacing:.25px}
.body-s{font-size:12px;line-height:16px;letter-spacing:.4px}
.label-l{font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px}
.label-s{font-size:11px;line-height:16px;font-weight:500;letter-spacing:.5px}
.muted{color:var(--md-sys-color-on-surface-variant)}
.mono{font-family:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.num{font-variant-numeric:tabular-nums}

/* ---------- 顶栏 ---------- */
.topbar{
  position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:8px;
  height:64px;padding:0 12px;
  background:var(--md-sys-color-surface-container);
  color:var(--md-sys-color-on-surface);
  transition:background-color var(--dur-m) var(--ease-std),box-shadow var(--dur-m) var(--ease-std);
}
.topbar .brand{display:flex;align-items:center;gap:8px;font-size:20px;line-height:28px;min-width:0}
.topbar .brand b{font-weight:500;white-space:nowrap}
.topbar .brand .mark{color:var(--md-sys-color-primary);display:flex}
.topbar .spacer{flex:1;min-width:8px}
.menubtn{display:none}

/* ---------- 骨架 ---------- */
.shell{display:flex;min-height:calc(100vh - 64px)}
.scrim{
  position:fixed;inset:0;z-index:35;background:var(--md-sys-color-scrim);
  opacity:0;visibility:hidden;
  transition:opacity var(--dur-m) var(--ease-std),visibility var(--dur-m) var(--ease-std);
}
.rail{
  width:88px;flex:0 0 88px;padding:12px 0;display:flex;flex-direction:column;gap:4px;align-items:center;
  background:var(--md-sys-color-surface);
}
.drawerhead{display:none}
.navitem{
  width:72px;border:0;background:none;color:var(--md-sys-color-on-surface-variant);
  display:flex;flex-direction:column;align-items:center;gap:4px;padding:0;cursor:pointer;font:inherit;
  position:relative;
}
.navitem .pill{
  width:56px;height:32px;border-radius:16px;display:grid;place-items:center;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
  position:relative;overflow:hidden;
}
.navitem .pill::after{
  content:"";position:absolute;inset:0;background:currentColor;opacity:0;
  transition:opacity var(--dur-s) var(--ease-std);
}
.navitem:hover .pill::after{opacity:.08}
.navitem:active .pill::after{opacity:.12}
.navitem[aria-selected=true] .pill{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
.navitem[aria-selected=true]{color:var(--md-sys-color-on-surface)}
.navitem .rl{font-size:12px;font-weight:500;line-height:16px;white-space:nowrap}
.railfoot{
  margin-top:auto;padding-top:10px;width:72px;display:flex;flex-direction:column;align-items:center;
  border-top:1px solid var(--md-sys-color-outline-variant);
}
.railfoot .rl{font-size:10.5px;letter-spacing:0}
.themestate{font-size:10px;line-height:14px;color:var(--md-sys-color-on-surface-variant);white-space:nowrap}

main{flex:1;min-width:0;padding:8px 24px 96px}
.wrap{max-width:1080px;margin:0 auto}
#pane.enter{animation:fadeUp var(--dur-m) var(--ease-emph-out) both}
.head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:16px 0 4px}
.head h2{margin:0}
.head .spacer{flex:1}
.sub{margin:0 0 20px;color:var(--md-sys-color-on-surface-variant)}

/* ---------- 卡片 ---------- */
.card{
  background:var(--md-sys-color-surface-container-low);
  border-radius:16px;padding:20px;margin-bottom:16px;
  transition:background-color var(--dur-m) var(--ease-std),box-shadow var(--dur-m) var(--ease-std);
}
.card.outlined{background:var(--md-sys-color-surface);border:1px solid var(--md-sys-color-outline-variant)}
.card.elev{background:var(--md-sys-color-surface-container-lowest);box-shadow:var(--md-elev-1)}
.card.elev:hover{box-shadow:var(--md-elev-2)}
.card h3{margin:0 0 4px}
.grid{display:grid;gap:16px}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid.three{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.stat{
  background:var(--md-sys-color-surface-container);border-radius:16px;padding:16px 20px;
  animation:popIn var(--dur-m) var(--ease-emph-out) both;
  transition:background-color var(--dur-m) var(--ease-std);
}
.stat .n{font-size:30px;line-height:38px;font-weight:400;color:var(--md-sys-color-primary);font-variant-numeric:tabular-nums}

/* ---------- 按钮 ---------- */
button.btn{
  font:inherit;font-weight:500;letter-spacing:.1px;cursor:pointer;border:0;
  min-height:40px;padding:0 24px;border-radius:20px;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);
  position:relative;overflow:hidden;
  transition:box-shadow var(--dur-m) var(--ease-std),transform 90ms var(--ease-std),background-color var(--dur-m) var(--ease-std);
}
button.btn::after,button.icon::after,a.btn::after{
  content:"";position:absolute;inset:0;background:currentColor;opacity:0;pointer-events:none;
  transition:opacity var(--dur-s) var(--ease-std);
}
button.btn:hover::after,button.icon:hover::after{opacity:.08}
button.btn:active::after,button.icon:active::after{opacity:.12}
button.btn:hover{box-shadow:var(--md-elev-1)}
button.btn:active{transform:scale(.97)}
button.btn:disabled{opacity:.38;cursor:not-allowed;box-shadow:none;transform:none}
button.btn:disabled::after{opacity:0}
button.btn.tonal{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
button.btn.outlined{background:transparent;color:var(--md-sys-color-primary);border:1px solid var(--md-sys-color-outline)}
button.btn.text{background:transparent;color:var(--md-sys-color-primary);padding:0 12px}
button.btn.danger{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container)}
button.btn.small{min-height:32px;height:32px;padding:0 16px;font-size:13px;border-radius:16px}
button.btn.icononly{padding:0;width:40px;min-width:40px}
a.btn{
  font:inherit;font-weight:500;text-decoration:none;min-height:40px;padding:0 24px;border-radius:20px;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;position:relative;overflow:hidden;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);
}
button.icon{
  border:0;background:transparent;color:var(--md-sys-color-on-surface-variant);cursor:pointer;
  width:40px;height:40px;min-width:40px;border-radius:20px;display:grid;place-items:center;
  position:relative;overflow:hidden;
  transition:background-color var(--dur-m) var(--ease-std),transform 90ms var(--ease-std),color var(--dur-m) var(--ease-std);
}
button.icon:active{transform:scale(.92)}
button.icon:disabled{opacity:.38;cursor:not-allowed}
button.icon:disabled::after{opacity:0}
button.icon.spinning svg{animation:spin 900ms linear infinite;transform-origin:50% 50%}

/* ---------- 输入 ---------- */
.field{position:relative;margin:0 0 20px}
.field>label{
  display:block;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.4px;
  color:var(--md-sys-color-on-surface-variant);margin-bottom:6px;
}
.field input,.field select,.field textarea{
  width:100%;font:inherit;color:var(--md-sys-color-on-surface);
  background:var(--md-sys-color-surface-container-highest);
  border:0;border-bottom:1px solid var(--md-sys-color-on-surface-variant);
  border-radius:4px 4px 0 0;padding:12px 16px;min-height:48px;
  transition:border-color var(--dur-s) var(--ease-std),background-color var(--dur-m) var(--ease-std);
}
.field textarea{min-height:96px;resize:vertical;font-family:"Roboto Mono",ui-monospace,monospace;font-size:13px}
.field input:focus,.field select:focus,.field textarea:focus{
  outline:none;border-bottom:2px solid var(--md-sys-color-primary);padding-bottom:11px;
}
.hint{font-size:12px;line-height:16px;color:var(--md-sys-color-on-surface-variant);margin-top:4px}
/* 全圆角输入框：圆弧半径与 40px 高的按钮保持一致（20px） */
.field.round input{
  border:1px solid var(--md-sys-color-outline);
  border-radius:20px;
  background:var(--md-sys-color-surface-container-highest);
  padding:12px 20px;
}
.field.round input:focus{
  border:2px solid var(--md-sys-color-primary);
  border-radius:20px;
  padding:11px 19px;
}

/* ---------- 开关 ---------- */
.switch{display:flex;align-items:center;gap:12px;padding:8px 0;cursor:pointer}
.switch input{position:absolute;opacity:0;width:0;height:0}
.switch .track{
  width:52px;height:32px;border-radius:16px;flex:0 0 52px;position:relative;
  background:var(--md-sys-color-surface-container-highest);
  border:2px solid var(--md-sys-color-outline);
  transition:background-color var(--dur-m) var(--ease-emph),border-color var(--dur-m) var(--ease-emph);
}
.switch .track::after{
  content:"";position:absolute;top:6px;left:6px;width:16px;height:16px;border-radius:50%;
  background:var(--md-sys-color-outline);
  transition:transform var(--dur-m) var(--ease-emph),width var(--dur-m) var(--ease-emph),height var(--dur-m) var(--ease-emph),top var(--dur-m) var(--ease-emph),left var(--dur-m) var(--ease-emph),background-color var(--dur-m) var(--ease-emph);
}
.switch input:checked+.track{background:var(--md-sys-color-primary);border-color:var(--md-sys-color-primary)}
.switch input:checked+.track::after{transform:translateX(20px);width:24px;height:24px;top:2px;left:2px;background:var(--md-sys-color-on-primary)}
.switch input:focus-visible+.track{outline:3px solid var(--md-sys-color-primary);outline-offset:2px}

/* ---------- Chip ---------- */
.chip{
  display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;
  border:1px solid var(--md-sys-color-outline-variant);color:var(--md-sys-color-on-surface-variant);
  font-size:13px;font-weight:500;background:transparent;cursor:default;
  white-space:nowrap;flex:0 0 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;
  transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
}
.chip.on{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container);border-color:transparent}
.chip.pri{background:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container);border-color:transparent}
.chip.err{background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);border-color:transparent}
.chip.ok{background:var(--md-sys-color-success-container);color:var(--md-sys-color-on-success-container);border-color:transparent}
.chip.sel{cursor:pointer}
.chips{display:flex;gap:8px;flex-wrap:wrap;min-width:0}

/* ---------- 列表 ---------- */
.list{display:flex;flex-direction:column;gap:8px}
.item{
  background:var(--md-sys-color-surface-container);border-radius:12px;padding:14px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;
  animation:fadeUp var(--dur-m) var(--ease-emph-out) both;
  transition:background-color var(--dur-m) var(--ease-std);
}
.list>.item:nth-child(1){animation-delay:0ms}
.list>.item:nth-child(2){animation-delay:35ms}
.list>.item:nth-child(3){animation-delay:70ms}
.list>.item:nth-child(4){animation-delay:105ms}
.list>.item:nth-child(5){animation-delay:140ms}
.list>.item:nth-child(6){animation-delay:175ms}
.list>.item:nth-child(7){animation-delay:210ms}
.list>.item:nth-child(n+8){animation-delay:240ms}
.item .grow{flex:1 1 240px;min-width:0}
.item .acts{display:flex;gap:4px;align-items:center;margin-left:auto;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.item .ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ordinal{
  width:32px;height:32px;flex:0 0 32px;border-radius:8px;display:grid;place-items:center;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);font-weight:500;font-size:13px;
}
.ordinal.off{background:var(--md-sys-color-surface-container-highest);color:var(--md-sys-color-on-surface-variant)}
.empty{
  border:1px dashed var(--md-sys-color-outline-variant);border-radius:16px;padding:32px 20px;text-align:center;
  color:var(--md-sys-color-on-surface-variant);animation:fadeIn var(--dur-m) var(--ease-std) both;
}

/* ---------- 表格 ---------- */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px;background:var(--md-sys-color-surface-container)}
table.md{width:100%;border-collapse:collapse;font-size:13px;min-width:420px}
table.md th{
  text-align:left;font-weight:500;font-size:12px;letter-spacing:.4px;white-space:nowrap;
  color:var(--md-sys-color-on-surface-variant);padding:12px 14px;
  border-bottom:1px solid var(--md-sys-color-outline-variant);
}
table.md td{padding:12px 14px;border-bottom:1px solid var(--md-sys-color-outline-variant);white-space:nowrap}
table.md tbody tr:last-child td{border-bottom:0}
table.md th.r,table.md td.r{text-align:right;font-variant-numeric:tabular-nums}
table.md tfoot td{font-weight:500;border-top:1px solid var(--md-sys-color-outline);border-bottom:0}

/* ---------- 对话框 ---------- */
dialog{
  border:0;border-radius:28px;padding:24px;max-width:min(560px,calc(100vw - 32px));width:100%;
  max-height:calc(100vh - 48px);overflow:auto;
  background:var(--md-sys-color-surface-container-high);color:var(--md-sys-color-on-surface);
  box-shadow:var(--md-elev-3);
}
dialog[open]{animation:dlgIn var(--dur-l) var(--ease-emph-out) both}
dialog::backdrop{background:var(--md-sys-color-scrim);animation:fadeIn var(--dur-m) var(--ease-std) both}
dialog h3{margin:0 0 8px}
dialog .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px;flex-wrap:wrap}
.scroll{max-height:46vh;overflow:auto;margin:8px -4px;padding:0 4px}

/* ---------- 提示条 ---------- */
/* 之前用 translateY(120%) 藏，元素本身有 padding，算下来底部还会露出十几像素的色块。
   现在改成 opacity + visibility 双保险，并且内容为空时直接不参与布局。 */
#snack{
  position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));
  transform:translate(-50%,16px);
  opacity:0;visibility:hidden;pointer-events:none;
  background:var(--md-sys-color-inverse-surface);color:var(--md-sys-color-inverse-on-surface);
  padding:14px 16px;border-radius:8px;box-shadow:var(--md-elev-3);z-index:99;
  max-width:min(560px,calc(100vw - 32px));
  transition:opacity var(--dur-m) var(--ease-std),transform var(--dur-m) var(--ease-emph-out),visibility var(--dur-m) var(--ease-std);
}
#snack.on{opacity:1;visibility:visible;transform:translate(-50%,0)}
#snack:empty{display:none}
.banner{
  background:var(--md-sys-color-error-container);color:var(--md-sys-color-on-error-container);
  border-radius:12px;padding:14px 16px;margin-bottom:16px;
  animation:fadeUp var(--dur-m) var(--ease-emph-out) both;
}
.banner.info{background:var(--md-sys-color-tertiary-container);color:var(--md-sys-color-on-tertiary-container)}

/* ---------- 登录 ---------- */
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login .card{
  width:min(400px,100%);text-align:center;background:var(--md-sys-color-surface-container-low);
  animation:fadeUp var(--dur-l) var(--ease-emph-out) both;
}
.login .logo{margin-bottom:8px;display:flex;justify-content:center;color:var(--md-sys-color-primary)}
.login .logo svg{width:40px;height:40px}
.login .field{text-align:left}

/* ---------- 代码块 ---------- */
pre.code{
  background:var(--md-sys-color-surface-container-highest);border-radius:12px;padding:14px 16px;
  overflow:auto;font-size:12.5px;line-height:1.6;margin:0;
  font-family:"Roboto Mono",ui-monospace,monospace;
}
.keyout{
  background:var(--md-sys-color-primary-container);color:var(--md-sys-color-on-primary-container);
  border-radius:12px;padding:14px 16px;word-break:break-all;font-family:"Roboto Mono",ui-monospace,monospace;font-size:13px;
}

/* ---------- <=840px：侧栏变模态抽屉 ---------- */
@media(max-width:840px){
  .menubtn{display:grid}
  body.nav-open .scrim{opacity:1;visibility:visible}
  .rail{
    position:fixed;left:0;top:0;bottom:0;z-index:40;
    width:min(300px,84vw);flex-basis:auto;
    padding:12px;gap:2px;align-items:stretch;
    background:var(--md-sys-color-surface-container-low);
    border-radius:0 16px 16px 0;box-shadow:var(--md-elev-3);
    overflow-y:auto;overscroll-behavior:contain;
    transform:translateX(-104%);
    transition:transform var(--dur-l) var(--ease-emph);
  }
  body.nav-open .rail{transform:none}
  .drawerhead{
    display:flex;align-items:center;gap:8px;padding:4px 4px 12px 12px;
    color:var(--md-sys-color-on-surface-variant);
  }
  .drawerhead .t{flex:1;font-size:14px;font-weight:500;letter-spacing:.5px}
  .navitem{
    flex-direction:row;width:100%;height:56px;min-height:56px;border-radius:28px;
    padding:0 16px;gap:12px;justify-content:flex-start;
    transition:background-color var(--dur-m) var(--ease-std),color var(--dur-m) var(--ease-std);
  }
  .navitem::after{
    content:"";position:absolute;inset:0;border-radius:28px;background:currentColor;opacity:0;
    transition:opacity var(--dur-s) var(--ease-std);pointer-events:none;
  }
  .navitem:hover::after{opacity:.08}
  .navitem:active::after{opacity:.12}
  .navitem .pill{width:auto;height:auto;background:none!important;border-radius:0}
  .navitem .pill::after{display:none}
  .navitem[aria-selected=true]{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
  .navitem .rl{font-size:14px;line-height:20px}
  .railfoot{width:100%;margin-top:auto;padding-top:8px;align-items:stretch}
  .railfoot .navitem{justify-content:flex-start}
  .railfoot .rl{font-size:14px}
  .themestate{font-size:12px;margin-left:auto}
  main{padding:8px 16px 96px}
}

/* ---------- <=600px：紧凑布局，基准 375px ---------- */
@media(max-width:600px){
  main{padding:4px 12px 88px}
  .topbar{padding:0 4px;gap:2px;height:60px}
  .topbar .brand{font-size:17px;gap:6px}
  .topbar .brand .long{display:none}
  .card{padding:16px;border-radius:16px}
  .head{flex-direction:column;align-items:stretch;gap:10px;margin:12px 0 4px}
  .head .spacer{display:none}
  .head>.btn{width:100%}
  .headline-s{font-size:22px;line-height:28px}
  .sub{margin-bottom:16px}
  /* 列表项：正文整行，操作按钮另起一行靠右，避免互相挤压把文字压成竖排 */
  .item{align-items:flex-start;padding:14px;gap:10px}
  .item .grow{flex:1 1 100%}
  .item .acts{
    width:100%;margin-left:0;justify-content:flex-end;
    padding-top:10px;border-top:1px solid var(--md-sys-color-outline-variant);
  }
  .item .acts .btn.small{flex:0 0 auto}
  .chip{height:28px;font-size:12px;padding:0 10px}
  .chips{gap:6px}
  .stat{padding:14px 16px}
  .stat .n{font-size:26px;line-height:34px}
  button.btn{padding:0 18px}
  button.btn.small{padding:0 14px}
  dialog{
    border-radius:28px;padding:20px 16px;
    max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);
  }
  dialog .actions{margin-top:20px}
  dialog .actions .btn{flex:1 1 auto}
  .scroll{max-height:52vh}
  .login{padding:16px}
  .login .card{padding:24px 20px}
  pre.code{font-size:12px;padding:12px}
  .field{margin-bottom:16px}
  #snack{left:12px;right:12px;transform:translateY(16px);max-width:none}
  #snack.on{transform:translateY(0)}
  table.md .hide-sm{display:none}
  table.md th,table.md td{padding:10px}
}
@media(max-width:400px){
  .logouttext{display:none}
  button.btn.logout{width:40px;min-width:40px;padding:0}
}
`;

// ---------- src/ui/app.js ----------
// 后台前端。写成一个函数，构建时用 Function.prototype.toString() 内联进 HTML，
// 这样这里可以正常用模板字符串，不需要满屏转义。
//
// 图标全部是手写的 24x24 描边 SVG（不是 emoji，也不引外部图标字体）：
// emoji 在不同系统里渲染差异极大，而外部字体要多花一次请求。

function uiApp() {
  var S = {
    authed: false, hasPassword: true, kvBound: true,
    presets: [], config: null, keys: [], cooldown: [], stats: null, usage: null, disguise: null,
  };
  var TAB = 'overview';
  var discovered = { providerId: null, list: [], picked: {} };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var root = $('#root');

  // ---------- 图标 ----------

  var ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M18 6l-.9-3.4M18 6l-3.4-.9"/>',
    logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M16 8l4 4-4 4M20 12H9"/>',
    moon: '<path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    overview: '<rect x="3.5" y="3.5" width="7" height="8" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="14.5" width="7" height="6" rx="2"/>',
    hub: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="17" r="2"/><circle cx="5" cy="17" r="2"/><path d="M12 9V6M14.6 13.7l2.6 1.6M9.4 13.7l-2.6 1.6"/>',
    layers: '<path d="M12 2.5 2.5 7 12 11.5 21.5 7 12 2.5Z"/><path d="M2.5 12 12 16.5 21.5 12"/><path d="M2.5 17 12 21.5 21.5 17"/>',
    key: '<circle cx="7.5" cy="12" r="3.5"/><path d="M11 12h9.5M17.5 12v3M20.5 12v2.5"/>',
    chart: '<path d="M3 20.5h18"/><path d="M6.5 20.5V12M12 20.5V4.5M17.5 20.5v-5.5"/>',
    tune: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.6"/><circle cx="8" cy="17" r="2.6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
    up: '<path d="M12 19.5V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 4.5V19M18 13l-6 6-6-6"/>',
    edit: '<path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="M14.5 6.5l3 3"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
    copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 15h-.5A1.5 1.5 0 0 1 3.5 13.5v-9A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6 21 21"/>',
    bolt: '<path d="M13 2.5 5.5 13.5H11l-1 8 7.5-11H12l1-8Z"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.95 6.75 19.7l1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/>',
    mark: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.2v3.4M12 18.4v3.4M2.2 12h3.4M18.4 12h3.4"/><path d="M5.1 5.1l2.4 2.4M16.5 16.5l2.4 2.4M18.9 5.1l-2.4 2.4M7.5 16.5l-2.4 2.4"/>',
  };

  function svg(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('en-US');
  }

  function when(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
  }

  function toast(msg, ms) {
    var el = $('#snack');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.remove('on');
      // 收起动画放完再清空文本，避免 :empty 立刻把元素抽掉导致动画被打断
      setTimeout(function () { if (!el.classList.contains('on')) el.textContent = ''; }, 300);
    }, ms || 3200);
  }

  async function api(path, body) {
    var res = await fetch('/admin/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && path !== 'login') { S.authed = false; render(); throw new Error('会话已过期，请重新登录。'); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('请求失败 ' + res.status));
    return data;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e2) { toast('复制失败，请手动选中'); }
      ta.remove();
    }
  }

  // ---------- 启动 ----------

  async function boot() {
    try {
      var s = await api('session');
      S.authed = s.authed; S.hasPassword = s.hasPassword;
      if (S.authed) await loadState();
    } catch (e) { /* 未登录 */ }
    render();
  }

  async function loadState() {
    var data = await api('state');
    S.kvBound = data.kvBound;
    S.presets = data.presets;
    S.config = data.config;
    S.keys = data.keys;
    S.cooldown = data.cooldown;
    S.stats = data.stats;
    S.usage = data.usage;
    S.disguise = data.disguise;
    S.defaults = data.defaults;
  }

  async function refresh() { await loadState(); render(); }

  // ---------- 渲染 ----------

  function render() {
    if (!S.authed) { closeNav(); renderLogin(); return; }
    closeNav();
    root.innerHTML = shell();
    bindShell();
    renderTab();
  }

  function renderLogin() {
    root.innerHTML =
      '<div class="login"><div class="card elev">' +
      '<div class="logo">' + svg('mark') + '</div>' +
      '<h1 class="headline-s">LLM Gateway</h1>' +
      '<p class="body-m muted" style="margin:8px 0 24px">用环境变量 admin_password 里设置的密码登录。</p>' +
      (S.hasPassword ? '' : '<div class="banner">还没有设置 admin_password。请到 Cloudflare 控制台的变量与机密里添加纯文本变量 admin_password，然后重新部署。</div>') +
      '<div class="field round"><label for="pw">管理员密码</label><input id="pw" type="password" autocomplete="current-password"></div>' +
      '<button class="btn" id="loginBtn" style="width:100%">登录</button>' +
      '</div></div>';
    var go = async function () {
      var btn = $('#loginBtn'); btn.disabled = true;
      try {
        await api('login', { password: $('#pw').value });
        S.authed = true;
        await loadState();
        render();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    $('#loginBtn').onclick = go;
    $('#pw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    $('#pw').focus();
  }

  var TABS = [
    { id: 'overview', icon: 'overview', label: '概览' },
    { id: 'providers', icon: 'hub', label: '提供商' },
    { id: 'models', icon: 'layers', label: '模型链' },
    { id: 'keys', icon: 'key', label: '密钥' },
    { id: 'usage', icon: 'chart', label: '用量' },
    { id: 'settings', icon: 'tune', label: '设置' },
    { id: 'edge', icon: 'globe', label: '优选 IP' },
  ];

  function isDark() { return document.documentElement.dataset.theme === 'dark'; }

  function themeItem() {
    var dark = isDark();
    return '<button class="navitem" id="themeBtn" type="button" title="夜间模式切换">' +
      '<span class="pill">' + svg(dark ? 'sun' : 'moon') + '</span>' +
      '<span class="rl">夜间模式切换</span>' +
      '<span class="themestate">' + (dark ? '深色' : '浅色') + '</span></button>';
  }

  function shell() {
    var nav = TABS.map(function (t) {
      return '<button class="navitem" type="button" data-tab="' + t.id + '" aria-selected="' + (TAB === t.id) + '">' +
        '<span class="pill">' + svg(t.icon) + '</span><span class="rl">' + t.label + '</span></button>';
    }).join('');

    return '' +
      '<header class="topbar">' +
      '<button class="icon menubtn" id="menuBtn" type="button" aria-label="打开菜单" aria-expanded="false">' + svg('menu') + '</button>' +
      '<span class="brand"><span class="mark">' + svg('mark') + '</span><b>LLM Gateway</b>' +
      '<span class="long body-s muted">OpenAI 兼容聚合网关</span></span>' +
      '<span class="spacer"></span>' +
      '<button class="icon" id="reloadBtn" type="button" title="刷新" aria-label="刷新">' + svg('refresh') + '</button>' +
      '<button class="btn tonal small logout" id="logoutBtn" type="button" aria-label="退出控制台">' +
      svg('logout', 'sm') + '<span class="logouttext">退出</span></button>' +
      '</header>' +
      '<div class="scrim" id="scrim"></div>' +
      '<div class="shell">' +
      '<nav class="rail" id="rail" aria-label="功能导航">' +
      '<div class="drawerhead"><span class="t">导航</span>' +
      '<button class="icon" id="navClose" type="button" aria-label="关闭菜单">' + svg('close') + '</button></div>' +
      nav +
      '<div class="railfoot">' + themeItem() + '</div>' +
      '</nav>' +
      '<main><div class="wrap" id="pane"></div></main></div>';
  }

  function openNav() {
    document.body.classList.add('nav-open');
    var b = $('#menuBtn'); if (b) b.setAttribute('aria-expanded', 'true');
    var first = $('#rail .navitem'); if (first) first.focus();
  }
  function closeNav() {
    document.body.classList.remove('nav-open');
    var b = $('#menuBtn'); if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleNav() {
    if (document.body.classList.contains('nav-open')) closeNav(); else openNav();
  }

  function applyTheme(next) {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('gw-theme', next); } catch (e) {}
    var foot = $('.railfoot');
    if (foot) { foot.innerHTML = themeItem(); bindTheme(); }
  }

  function bindTheme() {
    var t = $('#themeBtn');
    if (t) t.onclick = function () { applyTheme(isDark() ? 'light' : 'dark'); };
  }

  function bindShell() {
    root.querySelectorAll('.navitem[data-tab]').forEach(function (b) {
      b.onclick = function () { TAB = b.dataset.tab; render(); };
    });
    bindTheme();
    $('#menuBtn').onclick = toggleNav;
    $('#navClose').onclick = closeNav;
    $('#scrim').onclick = closeNav;
    $('#reloadBtn').onclick = async function () {
      var b = this;
      b.classList.add('spinning'); b.disabled = true;
      try { await refresh(); toast('已刷新'); }
      catch (e) { toast(e.message); b.classList.remove('spinning'); b.disabled = false; }
    };
    $('#logoutBtn').onclick = async function () {
      await api('logout', {});
      S.authed = false; render();
    };
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav();
  });

  function renderTab() {
    var pane = $('#pane');
    if (TAB === 'overview') viewOverview(pane);
    else if (TAB === 'providers') viewProviders(pane);
    else if (TAB === 'models') viewModels(pane);
    else if (TAB === 'keys') viewKeys(pane);
    else if (TAB === 'usage') viewUsage(pane);
    else if (TAB === 'settings') viewSettings(pane);
    else if (TAB === 'edge') viewEdge(pane);
    // 重放一次进场动画：切页时内容淡入上移，不然内容是"啪"地换掉的
    pane.classList.remove('enter');
    void pane.offsetWidth;
    pane.classList.add('enter');
  }

  function warnings() {
    var out = '';
    if (!S.kvBound) out += '<div class="banner"><b>没有检测到 KV 绑定。</b> 现在改的任何配置都不会保存，重新部署就没了。请到 Worker/Pages 设置里新建 KV 命名空间绑定，变量名填 <span class="mono">KV</span>。</div>';
    if (S.config && !S.config.models.length) out += '<div class="banner info">还没有模型。先去「提供商」加一个上游，搜索模型后加入调用链。</div>';
    else if (S.keys && !S.keys.length) out += '<div class="banner info">还没有网关密钥。到「密钥」页创建一个，才能从外部调用。</div>';
    return out;
  }

  // ---------- 概览 ----------

  function viewOverview(pane) {
    var base = location.origin;
    var models = S.config.models;
    var dm = models.filter(function (m) { return m.id === S.config.defaultModel; })[0];
    pane.innerHTML =
      warnings() +
      '<div class="head"><h2 class="headline-s">概览</h2></div>' +
      '<p class="sub body-m">把下面这个地址填进 Claude Code、AstrBot、Cherry Studio 等客户端的 OpenAI Base URL。</p>' +
      '<div class="card elev">' +
      '<div class="title-s muted">接口地址</div>' +
      '<div class="row" style="margin:8px 0 16px"><code class="keyout" style="flex:1 1 200px">' + esc(base) + '/v1</code>' +
      '<button class="btn tonal small" data-copy="' + esc(base) + '/v1">' + svg('copy', 'sm') + '复制</button></div>' +
      '<div class="title-s muted">OpenAI 协议 · chat</div>' +
      '<div class="row" style="margin:8px 0 12px"><code class="mono body-s" style="flex:1 1 200px;word-break:break-all">' + esc(base) + '/v1/chat/completions</code>' +
      '<button class="btn text small" data-copy="' + esc(base) + '/v1/chat/completions">复制</button></div>' +
      '<div class="title-s muted">Anthropic 协议 · messages（给 Claude Code 用）</div>' +
      '<div class="row" style="margin:8px 0 0"><code class="mono body-s" style="flex:1 1 200px;word-break:break-all">' + esc(base) + '/v1/messages</code>' +
      '<button class="btn text small" data-copy="' + esc(base) + '">复制根地址</button></div>' +
      '</div>' +
      '<div class="grid three" style="margin-bottom:16px">' +
      stat('提供商', S.config.providers.length) +
      stat('调用链模型', models.filter(function (m) { return m.enabled !== false; }).length + ' / ' + models.length) +
      stat('可用密钥', S.keys.filter(function (k) { return k.enabled; }).length) +
      '</div>' +
      '<div class="card">' +
      '<h3 class="title-m">默认模型</h3>' +
      '<p class="body-m muted">客户端没指定模型、或指定了网关里不存在的模型时，从这个模型开始往下试。</p>' +
      (dm ? '<div class="chips"><span class="chip pri">' + esc(dm.alias) + '</span><span class="chip">上游 ' + esc(dm.model) + '</span></div>'
          : '<div class="chips"><span class="chip err">未设置</span></div>') +
      '</div>' +
      (S.cooldown.length ? '<div class="card"><h3 class="title-m">冷却中的模型</h3><p class="body-m muted">这些模型最近调用失败，冷却期内会被直接跳过，不发请求。</p><div class="chips">' +
        S.cooldown.map(function (c) {
          var m = models.filter(function (x) { return x.id === c.modelId; })[0];
          return '<span class="chip err">' + esc(m ? m.alias : c.modelId) + ' · ' + c.status + ' · ' + c.secondsLeft + 's</span>';
        }).join('') + '</div><div style="margin-top:12px"><button class="btn outlined small" id="clearCd">立即解除冷却</button></div></div>' : '') +
      '<div class="card outlined"><h3 class="title-m">接入示例</h3>' +
      '<pre class="code">curl ' + esc(base) + '/v1/chat/completions \\\n' +
      '  -H "Authorization: Bearer $GW_KEY" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"model":"' + esc(dm ? dm.alias : 'auto') + '","messages":[{"role":"user","content":"hi"}]}\'</pre>' +
      '<p class="body-s muted" style="margin-top:12px"><b>AstrBot</b>：提供商类型选 OpenAI，API Base 填 <span class="mono">' + esc(base) + '/v1</span>，' +
      '模型名照抄「模型链」页里的别名 —— 网关的 /v1/models 会把这些别名列出来，选不到模型多半是 base_url 少写了 /v1。<br>' +
      '<b>Claude Code</b>：它说的是 Anthropic 协议，所以要设 <span class="mono">ANTHROPIC_BASE_URL=' + esc(base) + '</span> 和 ' +
      '<span class="mono">ANTHROPIC_AUTH_TOKEN=你的网关密钥</span>，网关会自动在两种协议之间翻译。</p></div>' +
      '<div class="card"><h3 class="title-m">本 isolate 运行统计</h3>' +
      '<p class="body-s muted">只存在内存里，不写 KV。Cloudflare 回收实例后归零，属正常现象。按密钥累计的长期用量在「用量」页。</p>' +
      '<div class="chips"><span class="chip">请求 ' + S.stats.requests + '</span><span class="chip ok">成功 ' + S.stats.success + '</span><span class="chip err">全链失败 ' + S.stats.failed + '</span></div></div>';

    pane.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { copy(b.dataset.copy); }; });
    var cc = $('#clearCd');
    if (cc) cc.onclick = async function () { await api('cooldown/clear', {}); await refresh(); toast('冷却已解除'); };
  }

  function stat(label, n) {
    return '<div class="stat"><div class="n">' + esc(String(n)) + '</div><div class="body-s muted">' + esc(label) + '</div></div>';
  }

  // ---------- 提供商 ----------

  function viewProviders(pane) {
    var list = S.config.providers.map(function (p) {
      var count = S.config.models.filter(function (m) { return m.providerId === p.id; }).length;
      return '<div class="item">' +
        '<div class="grow"><div class="title-s">' + esc(p.name) + (p.enabled === false ? ' <span class="chip">已停用</span>' : '') + '</div>' +
        '<div class="body-s muted ellipsis mono">' + esc(p.baseUrl) + '</div>' +
        '<div class="chips" style="margin-top:8px"><span class="chip">' + esc(p.keyMask || '无 key') + '</span>' +
        '<span class="chip">鉴权 ' + esc(p.authStyle) + '</span><span class="chip">' + count + ' 个模型已入链</span></div></div>' +
        '<div class="acts">' +
        '<button class="btn tonal small" data-test="' + p.id + '">测试</button>' +
        '<button class="btn small" data-discover="' + p.id + '">' + svg('search', 'sm') + '搜索模型</button>' +
        '<button class="icon" data-edit="' + p.id + '" title="编辑" aria-label="编辑">' + svg('edit') + '</button>' +
        '<button class="icon" data-del="' + p.id + '" title="删除" aria-label="删除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">提供商</h2><span class="spacer"></span>' +
      '<button class="btn" id="addProv">' + svg('plus', 'sm') + '添加提供商</button></div>' +
      '<p class="sub body-m">填入各家的 API Key。所有 key 存在 KV 里，面板只显示掩码，不会回传明文。</p>' +
      (S.config.providers.length ? '<div class="list">' + list + '</div>'
        : '<div class="empty">还没有提供商。点上面的按钮添加一个，比如 DeepSeek 或 NVIDIA NIM。</div>');

    $('#addProv').onclick = function () { providerDialog(null); };
    pane.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { providerDialog(S.config.providers.filter(function (p) { return p.id === b.dataset.edit; })[0]); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('删除这个提供商？它名下已加入调用链的模型会一并删除。')) return;
        await api('providers/delete', { id: b.dataset.del });
        await refresh(); toast('已删除');
      };
    });
    pane.querySelectorAll('[data-test]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true; b.textContent = '测试中';
        try { var r = await api('providers/test', { id: b.dataset.test }); toast((r.ok ? '成功：' : '失败：') + r.message + ' (' + r.ms + 'ms)', 5000); }
        catch (e) { toast(e.message); }
        b.disabled = false; b.textContent = '测试';
      };
    });
    pane.querySelectorAll('[data-discover]').forEach(function (b) {
      b.onclick = function () { discoverDialog(b.dataset.discover); };
    });
  }

  function providerDialog(existing) {
    var p = existing || { type: 'deepseek', authStyle: 'bearer', enabled: true };
    var opts = S.presets.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === p.type ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('');
    var dlg = mkDialog(
      (existing ? '编辑提供商' : '添加提供商'),
      '<div class="field"><label for="pType">预设</label><select id="pType">' + opts + '</select><div class="hint" id="pNote"></div></div>' +
      '<div class="field"><label for="pName">显示名称</label><input id="pName" value="' + esc(p.name || '') + '"></div>' +
      '<div class="field"><label for="pUrl">Base URL（OpenAI 兼容端点，末尾不要带 /chat/completions）</label><input id="pUrl" class="mono" value="' + esc(p.baseUrl || '') + '"></div>' +
      '<div class="field"><label for="pKey">API Key' + (existing ? '（留空表示不修改）' : '') + '</label><input id="pKey" type="password" autocomplete="off" placeholder="' + esc(existing && existing.keyMask ? existing.keyMask : '') + '"></div>' +
      '<div class="field"><label for="pAuth">鉴权方式</label><select id="pAuth">' +
      ['bearer', 'api-key', 'x-api-key', 'custom'].map(function (a) {
        return '<option value="' + a + '"' + (a === p.authStyle ? ' selected' : '') + '>' + (a === 'bearer' ? 'Authorization: Bearer（多数厂商）' : a === 'custom' ? '自定义请求头' : a + ' 请求头') + '</option>';
      }).join('') + '</select></div>' +
      '<div id="customAuth" style="display:none"><div class="field"><label for="pHeadName">请求头名</label><input id="pHeadName" value="' + esc(p.authHeaderName || '') + '"></div>' +
      '<div class="field"><label for="pHeadPrefix">值前缀（可空）</label><input id="pHeadPrefix" value="' + esc(p.authHeaderPrefix || '') + '"></div></div>' +
      '<label class="switch"><input type="checkbox" id="pEnabled"' + (p.enabled !== false ? ' checked' : '') + '><span class="track"></span><span class="label-l">启用</span></label>',
      '保存'
    );

    var typeSel = $('#pType', dlg), urlIn = $('#pUrl', dlg), nameIn = $('#pName', dlg), authSel = $('#pAuth', dlg);
    function syncPreset(force) {
      var preset = S.presets.filter(function (x) { return x.id === typeSel.value; })[0];
      if (!preset) return;
      $('#pNote', dlg).textContent = preset.note || '';
      if (force || !urlIn.value) urlIn.value = preset.baseUrl || '';
      if (force || !nameIn.value) nameIn.value = preset.name;
      if (force) authSel.value = preset.authStyle || 'bearer';
      $('#customAuth', dlg).style.display = authSel.value === 'custom' ? 'block' : 'none';
    }
    typeSel.onchange = function () { syncPreset(true); };
    authSel.onchange = function () { $('#customAuth', dlg).style.display = authSel.value === 'custom' ? 'block' : 'none'; };
    syncPreset(false);

    $('#dlgOk', dlg).onclick = async function () {
      var payload = {
        id: existing ? existing.id : undefined,
        type: typeSel.value,
        name: nameIn.value.trim(),
        baseUrl: urlIn.value.trim(),
        apiKey: $('#pKey', dlg).value.trim(),
        authStyle: authSel.value,
        authHeaderName: $('#pHeadName', dlg).value.trim(),
        authHeaderPrefix: $('#pHeadPrefix', dlg).value.trim(),
        enabled: $('#pEnabled', dlg).checked,
      };
      try {
        await api('providers/save', { provider: payload });
        dlg.close(); dlg.remove();
        await refresh(); toast('已保存');
      } catch (e) { toast(e.message); }
    };
  }

  async function discoverDialog(providerId) {
    var prov = S.config.providers.filter(function (p) { return p.id === providerId; })[0];
    var dlg = mkDialog('搜索 ' + esc(prov.name) + ' 的模型',
      '<p class="body-m muted">正在用这把 key 请求上游的 /models…</p><div id="dList"></div>', '添加所选');
    $('#dlgOk', dlg).disabled = true;

    var r;
    try { r = await api('providers/discover', { id: providerId }); }
    catch (e) { $('#dList', dlg).innerHTML = '<div class="banner">' + esc(e.message) + '</div>'; return; }
    if (!r.ok) {
      $('#dList', dlg).innerHTML = '<div class="banner">' + esc(r.message) + '</div>' +
        '<p class="body-s muted">也可以直接手工填模型名：把上游模型 ID 写进下面的输入框。</p>' +
        '<div class="field"><label for="manual">手工添加（逗号分隔）</label><input id="manual" class="mono" placeholder="deepseek-chat, deepseek-reasoner"></div>';
      $('#dlgOk', dlg).disabled = false;
      $('#dlgOk', dlg).onclick = async function () {
        var ids = ($('#manual', dlg).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (!ids.length) return toast('先填至少一个模型名');
        await api('models/add', { providerId: providerId, models: ids.map(function (id) { return { id: id }; }) });
        dlg.close(); dlg.remove(); await refresh(); toast('已添加 ' + ids.length + ' 个');
      };
      return;
    }

    discovered = { providerId: providerId, list: r.models, picked: {} };
    $('#dlgOk', dlg).disabled = false;
    $('#dList', dlg).innerHTML =
      '<div class="field" style="margin-bottom:12px"><label for="filter">筛选（共 ' + r.count + ' 个）</label><input id="filter" placeholder="输入关键字，比如 flash / pro / vl"></div>' +
      '<div class="row" style="margin-bottom:8px"><button class="btn text small" id="selAll">全选当前</button><button class="btn text small" id="selNone">清空</button>' +
      '<span class="spacer" style="flex:1"></span><span class="body-s muted" id="cnt">已选 0</span></div>' +
      '<div class="scroll" id="mlist"></div>';

    function paint() {
      var q = ($('#filter', dlg).value || '').toLowerCase();
      var rows = discovered.list.filter(function (m) { return !q || m.id.toLowerCase().indexOf(q) >= 0; });
      $('#mlist', dlg).innerHTML = rows.length ? rows.map(function (m) {
        var caps = [];
        if (m.caps.vision) caps.push('视觉');
        if (m.caps.audio) caps.push('音频');
        if (m.caps.video) caps.push('视频');
        if (m.caps.tools) caps.push('工具');
        if (m.caps.reasoning) caps.push('推理');
        return '<label class="item" style="cursor:pointer">' +
          '<input type="checkbox" data-mid="' + esc(m.id) + '"' + (discovered.picked[m.id] ? ' checked' : '') + (m.added ? ' disabled' : '') + '>' +
          '<div class="grow"><div class="title-s mono ellipsis">' + esc(m.id) + '</div>' +
          '<div class="chips" style="margin-top:6px"><span class="chip">' + esc(m.kind) + '</span>' +
          caps.map(function (c) { return '<span class="chip on">' + c + '</span>'; }).join('') +
          (m.added ? '<span class="chip pri">已在链中</span>' : '') + '</div></div></label>';
      }).join('') : '<div class="empty">没有匹配的模型</div>';

      $('#mlist', dlg).querySelectorAll('input[data-mid]').forEach(function (cb) {
        cb.onchange = function () {
          if (cb.checked) discovered.picked[cb.dataset.mid] = true; else delete discovered.picked[cb.dataset.mid];
          $('#cnt', dlg).textContent = '已选 ' + Object.keys(discovered.picked).length;
        };
      });
    }
    $('#filter', dlg).oninput = paint;
    $('#selAll', dlg).onclick = function () {
      var q = ($('#filter', dlg).value || '').toLowerCase();
      discovered.list.forEach(function (m) { if (!m.added && (!q || m.id.toLowerCase().indexOf(q) >= 0)) discovered.picked[m.id] = true; });
      paint(); $('#cnt', dlg).textContent = '已选 ' + Object.keys(discovered.picked).length;
    };
    $('#selNone', dlg).onclick = function () { discovered.picked = {}; paint(); $('#cnt', dlg).textContent = '已选 0'; };
    paint();

    $('#dlgOk', dlg).onclick = async function () {
      var picked = Object.keys(discovered.picked);
      if (!picked.length) return toast('先勾选要调用的模型');
      var payload = picked.map(function (id) {
        var m = discovered.list.filter(function (x) { return x.id === id; })[0];
        return { id: id, kind: m.kind, caps: m.caps };
      });
      try {
        var res = await api('models/add', { providerId: providerId, models: payload });
        dlg.close(); dlg.remove();
        await refresh(); toast('已加入调用链 ' + res.added + ' 个模型');
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 模型链 ----------

  function viewModels(pane) {
    var models = S.config.models;
    var rows = models.map(function (m, i) {
      var p = S.config.providers.filter(function (x) { return x.id === m.providerId; })[0];
      var caps = [];
      if (m.caps) {
        if (m.caps.vision) caps.push('视觉');
        if (m.caps.audio) caps.push('音频');
        if (m.caps.video) caps.push('视频');
        if (m.caps.tools) caps.push('工具调用');
        if (m.caps.reasoning) caps.push('推理');
      }
      var isDefault = S.config.defaultModel === m.id;
      return '<div class="item">' +
        '<div class="ordinal' + (m.enabled === false ? ' off' : '') + '">' + (i + 1) + '</div>' +
        '<div class="grow"><div class="title-s ellipsis">' + esc(m.alias) + (isDefault ? ' <span class="chip pri">默认</span>' : '') + '</div>' +
        '<div class="body-s muted ellipsis mono">' + esc(p ? p.name : '提供商已删除') + ' · ' + esc(m.model) + '</div>' +
        '<div class="chips" style="margin-top:8px"><span class="chip">' + esc(m.kind || 'chat') + '</span>' +
        (caps.length ? caps.map(function (c) { return '<span class="chip on">' + c + '</span>'; }).join('') : '<span class="chip">纯文本</span>') +
        '</div></div>' +
        '<div class="acts">' +
        '<button class="icon" data-up="' + m.id + '"' + (i === 0 ? ' disabled' : '') + ' title="上移" aria-label="上移">' + svg('up') + '</button>' +
        '<button class="icon" data-down="' + m.id + '"' + (i === models.length - 1 ? ' disabled' : '') + ' title="下移" aria-label="下移">' + svg('down') + '</button>' +
        '<button class="btn tonal small" data-test="' + m.id + '">测试</button>' +
        '<button class="btn text small" data-default="' + m.id + '"' + (isDefault ? ' disabled' : '') + '>设为默认</button>' +
        '<button class="icon" data-edit="' + m.id + '" title="编辑" aria-label="编辑">' + svg('edit') + '</button>' +
        '<button class="icon" data-del="' + m.id + '" title="移除" aria-label="移除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">模型调用链</h2></div>' +
      '<p class="sub body-m">从上往下依次尝试：第 1 个能正常返回就用它，之后不再往后试。全部失败返回 403。序号 1 就是最优先。</p>' +
      (models.length ? '<div class="list">' + rows + '</div>' : '<div class="empty">调用链是空的。先到「提供商」搜索并添加模型。</div>');

    pane.querySelectorAll('[data-up],[data-down]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.dataset.up || b.dataset.down;
        var ids = models.map(function (m) { return m.id; });
        var i = ids.indexOf(id);
        var j = b.dataset.up ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        ids[i] = ids[j]; ids[j] = id;
        await api('models/reorder', { ids: ids });
        await refresh();
      };
    });
    pane.querySelectorAll('[data-default]').forEach(function (b) {
      b.onclick = async function () { await api('models/default', { id: b.dataset.default }); await refresh(); toast('已设为默认模型'); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('把这个模型移出调用链？')) return;
        await api('models/delete', { id: b.dataset.del }); await refresh(); toast('已移除');
      };
    });
    pane.querySelectorAll('[data-test]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true; b.textContent = '…';
        try { var r = await api('models/test', { id: b.dataset.test }); toast((r.ok ? '成功：' : '失败 ' + r.status + '：') + r.message + ' (' + r.ms + 'ms)', 6000); }
        catch (e) { toast(e.message); }
        b.disabled = false; b.textContent = '测试';
      };
    });
    pane.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { modelDialog(models.filter(function (m) { return m.id === b.dataset.edit; })[0]); };
    });
  }

  function modelDialog(m) {
    var capRows = [
      ['text', '文本'], ['vision', '视觉 / 图片'], ['audio', '音频'], ['video', '视频'],
      ['tools', '工具调用 function calling'], ['json', 'JSON 输出'], ['reasoning', '推理 / 思维链'],
    ].map(function (c) {
      return '<label class="switch"><input type="checkbox" data-cap="' + c[0] + '"' + (m.caps && m.caps[c[0]] ? ' checked' : '') + '><span class="track"></span><span class="label-l">' + c[1] + '</span></label>';
    }).join('');

    var dlg = mkDialog('编辑模型',
      '<div class="field"><label for="mAlias">对外别名（客户端里填的模型名）</label><input id="mAlias" class="mono" value="' + esc(m.alias) + '"></div>' +
      '<div class="field"><label for="mUp">上游模型 ID</label><input id="mUp" class="mono" value="' + esc(m.model) + '"></div>' +
      '<div class="field"><label for="mKind">类型</label><select id="mKind">' +
      ['chat', 'embedding', 'image', 'audio', 'video', 'rerank'].map(function (k) {
        return '<option value="' + k + '"' + (k === (m.kind || 'chat') ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select><div class="hint">embedding 类型只参与 /v1/embeddings，不进 chat 调用链。</div></div>' +
      '<div class="title-s" style="margin:16px 0 4px">能力标注</div>' +
      '<p class="body-s muted" style="margin:0 0 8px">上游的 /models 基本不返回模态信息，这里的初始值是按模型名猜的，不准就手工改。</p>' + capRows +
      '<div class="field" style="margin-top:16px"><label for="mDrop">转发时删掉的参数（逗号分隔）</label><input id="mDrop" class="mono" value="' + esc((m.dropParams || []).join(', ')) + '" placeholder="frequency_penalty, presence_penalty"><div class="hint">某些上游会因为不认识的参数直接 400，把它们填这里。</div></div>' +
      '<label class="switch"><input type="checkbox" id="mEnabled"' + (m.enabled !== false ? ' checked' : '') + '><span class="track"></span><span class="label-l">在调用链中启用</span></label>',
      '保存');

    $('#dlgOk', dlg).onclick = async function () {
      var caps = {};
      dlg.querySelectorAll('[data-cap]').forEach(function (cb) { caps[cb.dataset.cap] = cb.checked; });
      try {
        await api('models/save', {
          model: {
            id: m.id,
            alias: $('#mAlias', dlg).value.trim(),
            model: $('#mUp', dlg).value.trim(),
            kind: $('#mKind', dlg).value,
            caps: caps,
            enabled: $('#mEnabled', dlg).checked,
            dropParams: ($('#mDrop', dlg).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          },
        });
        dlg.close(); dlg.remove(); await refresh(); toast('已保存');
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 密钥 ----------

  function viewKeys(pane) {
    var rows = S.keys.map(function (k) {
      return '<div class="item">' +
        '<div class="grow"><div class="title-s">' + esc(k.name) + (k.enabled ? '' : ' <span class="chip">已停用</span>') + '</div>' +
        '<div class="body-s muted mono ellipsis">' + esc(k.prefix) + '…' + esc(k.tail) + '</div>' +
        '<div class="body-s muted">创建于 ' + when(k.createdAt) + '</div></div>' +
        '<div class="acts">' +
        '<button class="btn text small" data-toggle="' + k.id + '" data-en="' + (k.enabled ? '0' : '1') + '">' + (k.enabled ? '停用' : '启用') + '</button>' +
        '<button class="icon" data-del="' + k.id + '" title="删除" aria-label="删除">' + svg('trash') + '</button>' +
        '</div></div>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">网关密钥</h2><span class="spacer"></span><button class="btn" id="newKey">' + svg('plus', 'sm') + '创建密钥</button></div>' +
      '<p class="sub body-m">这是外部客户端用来调网关的 key。KV 里只存 SHA-256，明文只在创建那一刻显示一次，关掉就再也看不到了。</p>' +
      '<div id="freshKey"></div>' +
      (S.keys.length ? '<div class="list">' + rows + '</div>' : '<div class="empty">还没有密钥。创建一个，然后填进客户端的 API Key 栏。</div>');

    $('#newKey').onclick = function () {
      var dlg = mkDialog('创建网关密钥', '<div class="field"><label for="kName">密钥备注（必填）</label><input id="kName" placeholder="例如：AstrBot、笔记本"></div>' +
        '<p class="body-s muted">备注会显示在密钥列表和用量页里，用来区分是哪个客户端在调。创建后明文只显示一次，请立刻复制保存。</p>', '下一步');
      $('#dlgOk', dlg).onclick = async function () {
        var name = $('#kName', dlg).value.trim();
        if (!name) { toast('请输入密钥备注'); $('#kName', dlg).focus(); return; }
        try {
          var r = await api('keys/create', { name: name });
          dlg.close(); dlg.remove();
          await refresh();
          showFreshKey(r.key);
        } catch (e) { toast(e.message); }
      };
    };
    pane.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.onclick = async function () { await api('keys/toggle', { id: b.dataset.toggle, enabled: b.dataset.en === '1' }); await refresh(); };
    });
    pane.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('删除这把密钥？正在用它的客户端会立刻 401。')) return;
        await api('keys/delete', { id: b.dataset.del }); await refresh(); toast('已删除');
      };
    });
  }

  function showFreshKey(key) {
    var box = $('#freshKey');
    box.innerHTML = '<div class="card elev"><h3 class="title-m">新密钥（只显示这一次）</h3>' +
      '<p class="body-m muted">刷新页面后就查不到了，现在复制走。</p>' +
      '<div class="keyout" id="kv">' + esc(key) + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="kCopy">' + svg('copy', 'sm') + '复制密钥</button>' +
      '<button class="btn text" id="kHide">我已保存，隐藏</button></div></div>';
    $('#kCopy').onclick = function () { copy(key); };
    $('#kHide').onclick = function () { box.innerHTML = ''; };
  }

  // ---------- 用量 ----------

  function viewUsage(pane) {
    var u = S.usage || { keys: [], totals: {}, persisted: false };
    var t = u.totals || {};
    var rows = (u.keys || []).map(function (k) {
      return '<tr>' +
        '<td><div class="title-s">' + esc(k.name || '未命名') + (k.exists ? '' : ' <span class="chip">已删除</span>') + '</div>' +
        '<div class="body-s muted mono">' + esc(k.prefix || '') + '…' + esc(k.tail || '') + '</div></td>' +
        '<td class="r">' + fmt(k.calls) + '</td>' +
        '<td class="r">' + fmt(k.prompt) + '</td>' +
        '<td class="r">' + fmt(k.completion) + '</td>' +
        '<td class="r">' + fmt(k.total) + '</td>' +
        '<td class="body-s muted hide-sm">' + when(k.lastAt) + '</td>' +
        '<td><button class="btn text small" data-detail="' + esc(k.id) + '">明细</button></td>' +
        '</tr>';
    }).join('');

    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">用量</h2><span class="spacer"></span>' +
      '<button class="btn outlined" id="resetUsage">重置统计</button></div>' +
      '<p class="sub body-m">按网关密钥累计的调用次数与 token 数。上游返回 usage 字段时用真实值；没返回的（多数流式接口默认不带）用和 ' +
      '<span class="mono">/v1/messages/count_tokens</span> 同一套算法估算，估算过的条数单列出来。</p>' +
      '<div class="grid three" style="margin-bottom:16px">' +
      stat('总调用次数', fmt(t.calls)) +
      stat('输入 tokens', fmt(t.prompt)) +
      stat('输出 tokens', fmt(t.completion)) +
      '</div>' +
      (u.keys && u.keys.length
        ? '<div class="card" style="padding:0;overflow:hidden"><div class="tablewrap"><table class="md">' +
          '<thead><tr><th>密钥</th><th class="r">调用次数</th><th class="r">输入</th><th class="r">输出</th><th class="r">合计</th><th class="hide-sm">最近使用</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
          '<tfoot><tr><td>合计</td><td class="r">' + fmt(t.calls) + '</td><td class="r">' + fmt(t.prompt) + '</td>' +
          '<td class="r">' + fmt(t.completion) + '</td><td class="r">' + fmt(t.total) + '</td><td class="hide-sm"></td><td></td></tr></tfoot>' +
          '</table></div></div>'
        : '<div class="empty">还没有任何调用记录。用网关密钥打一次 /v1/chat/completions 就会出现在这里。</div>') +
      '<div class="card outlined"><h3 class="title-m">这些数字是怎么来的</h3>' +
      '<p class="body-m muted">计数在内存里累加，每隔一段时间批量写一次 KV（默认 ' + esc(String(u.flushSeconds || 300)) + ' 秒，' +
      '最坏情况一天不到 300 次写，免费版每天 1000 次写额度用不满）。' +
      (u.persisted ? '当前<b>已开启</b>持久化，重新部署或实例回收后数据仍在。' : '当前<b>未开启</b>持久化（或没绑 KV），实例回收后归零。') +
      '</p><div class="chips"><span class="chip">估算条数 ' + fmt(t.estimatedCalls) + '</span>' +
      '<span class="chip">待写入 ' + fmt(u.pending) + '</span>' +
      '<span class="chip">上次落盘 ' + when(u.updatedAt) + '</span></div></div>';

    pane.querySelectorAll('[data-detail]').forEach(function (b) {
      b.onclick = function () {
        var k = (u.keys || []).filter(function (x) { return x.id === b.dataset.detail; })[0];
        if (!k) return;
        var models = (k.byModel || []).map(function (m) {
          return '<tr><td class="mono">' + esc(m.name) + '</td><td class="r">' + fmt(m.calls) + '</td><td class="r">' + fmt(m.tokens) + '</td></tr>';
        }).join('');
        var eps = (k.byEndpoint || []).map(function (e) {
          return '<span class="chip">' + esc(e.name) + ' · ' + fmt(e.calls) + '</span>';
        }).join('');
        mkDialog('明细 · ' + esc(k.name || '未命名'),
          '<div class="chips" style="margin-bottom:16px">' + (eps || '<span class="chip">无</span>') + '</div>' +
          (models
            ? '<div class="tablewrap"><table class="md" style="min-width:340px"><thead><tr><th>模型</th><th class="r">次数</th><th class="r">tokens</th></tr></thead><tbody>' + models + '</tbody></table></div>'
            : '<div class="empty">还没有按模型的细分数据。</div>'),
          '关闭');
      };
    });

    $('#resetUsage').onclick = async function () {
      if (!confirm('清空所有密钥的用量统计？这个动作不可撤销。')) return;
      try { await api('usage/reset', {}); await refresh(); toast('用量已清空'); }
      catch (e) { toast(e.message); }
    };
  }

  // ---------- 设置 ----------

  function viewSettings(pane) {
    var s = S.config.settings;
    var dg = S.disguise || {};
    pane.innerHTML = warnings() +
      '<div class="head"><h2 class="headline-s">设置</h2></div>' +
      '<p class="sub body-m">默认值已经按 Cloudflare 免费额度调过，一般不用动。</p>' +
      '<div class="card"><h3 class="title-m">调用链行为</h3>' +
      sw('strictModelRouting', '严格模型路由', '开启后：客户端点名的模型失败就直接报错，不再往下降级。关闭则继续按顺序尝试。', s.strictModelRouting) +
      sw('rewriteModelName', '回写模型名', '把响应里的 model 字段改回客户端请求的名字。AstrBot 之类会校验模型名的客户端建议开着。', s.rewriteModelName) +
      numField('maxAttempts', '单次请求最多尝试模型数', s.maxAttempts, '免费版每次调用最多 50 个外部子请求，留足余量。') +
      numField('headerTimeoutMs', '等待上游响应头超时（毫秒）', s.headerTimeoutMs, '只管到响应头为止；流式回答开始后不再计时，不会被掐断。') +
      numField('cooldownSeconds', '失败冷却（秒）', s.cooldownSeconds, '某个模型失败后，这段时间内直接跳过，连请求都不发 —— 省的就是这些。填 0 关闭。') +
      sw('peekStreamErrors', '识破藏在流里的错误', '有的上游返回 200，错误却在 SSE 第一个事件里。开启后先看一眼首块，是错误就无感转到下一个模型。', s.peekStreamErrors) +
      '</div>' +
      '<div class="card"><h3 class="title-m">请求改写</h3>' +
      sw('mapDeveloperRole', 'developer 角色映射成 system', '新版 OpenAI SDK 会把 system 发成 developer，除 OpenAI 外几乎没有兼容接口认它（MiniMax 直接 400）。', s.mapDeveloperRole) +
      '</div>' +
      '<div class="card"><h3 class="title-m">接口</h3>' +
      sw('allowAnonymousModels', '/v1/models 允许匿名访问', '有些客户端会在填 key 之前先拉一次模型列表。除非遇到问题，否则保持关闭。', s.allowAnonymousModels) +
      sw('exposeProviderInList', '模型列表里显示提供商', '在 owned_by 字段里写上提供商名字。', s.exposeProviderInList) +
      '</div>' +
      '<div class="card"><h3 class="title-m">用量统计</h3>' +
      sw('trackUsage', '记录每把密钥的调用次数与 tokens', '关掉后「用量」页不再增加新数据，转发路径上也省掉一次响应体扫描。', s.trackUsage) +
      numField('usageFlushSeconds', '统计落盘间隔（秒）', s.usageFlushSeconds, '越大越省 KV 写额度，越小面板数字越新。最小 30 秒。') +
      '</div>' +
      '<div class="row"><button class="btn" id="saveSet">保存设置</button></div>' +
      '<div class="card outlined" style="margin-top:24px"><h3 class="title-m">首页伪装</h3>' +
      '<p class="body-m muted">用环境变量 <span class="mono">url</span> 控制，改完要重新部署才生效 —— 它是部署级变量，不走 KV，所以这里只能看不能改。' +
      '设置后访问根路径 <span class="mono">/</span> 会直接吐出目标站点的首页，看不出这是个网关；控制台仍在 <span class="mono">/admin</span>。' +
      '不设就默认伪装成 <span class="mono">www.bing.com</span>；填 <span class="mono">off</span> 则显示网关自带的落地页。</p>' +
      '<div class="chips">' +
      (dg.enabled
        ? '<span class="chip ok">已开启</span><span class="chip mono">' + esc(dg.target || '') + '</span>'
        : '<span class="chip">已关闭，显示自带落地页</span>') +
      '</div></div>' +
      '<div class="card outlined"><h3 class="title-m">备份</h3>' +
      '<p class="body-m muted">导出内容包含上游 API Key 明文，请当密码文件保管。</p>' +
      '<div class="row"><button class="btn tonal" id="expBtn">导出配置</button><button class="btn outlined" id="impBtn">导入配置</button></div></div>';

    $('#saveSet').onclick = async function () {
      var payload = {};
      pane.querySelectorAll('[data-set]').forEach(function (el) {
        payload[el.dataset.set] = el.type === 'checkbox' ? el.checked : Number(el.value);
      });
      try { await api('settings/save', { settings: payload }); await refresh(); toast('设置已保存'); }
      catch (e) { toast(e.message); }
    };
    $('#expBtn').onclick = async function () {
      var r = await api('export');
      var blob = new Blob([JSON.stringify(r.config, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'llm-gateway-config.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    };
    $('#impBtn').onclick = function () {
      var dlg = mkDialog('导入配置', '<div class="field"><label for="impText">粘贴导出的 JSON</label><textarea id="impText" style="min-height:200px"></textarea></div><p class="body-s muted">导入会整体覆盖现有的提供商、模型和设置。网关密钥不受影响。</p>', '覆盖导入');
      $('#dlgOk', dlg).onclick = async function () {
        try {
          var cfg = JSON.parse($('#impText', dlg).value);
          var r = await api('import', { config: cfg });
          dlg.close(); dlg.remove(); await refresh();
          toast('已导入 ' + r.providers + ' 个提供商 / ' + r.models + ' 个模型');
        } catch (e) { toast('导入失败：' + e.message); }
      };
    };
  }

  function sw(key, label, hint, val) {
    return '<label class="switch"><input type="checkbox" data-set="' + key + '"' + (val ? ' checked' : '') + '><span class="track"></span>' +
      '<span><span class="label-l">' + esc(label) + '</span><br><span class="body-s muted">' + esc(hint) + '</span></span></label>';
  }
  function numField(key, label, val, hint) {
    return '<div class="field" style="margin-top:12px"><label>' + esc(label) + '</label><input type="number" data-set="' + key + '" value="' + esc(String(val)) + '"><div class="hint">' + esc(hint) + '</div></div>';
  }

  // ---------- 优选 IP ----------

  function viewEdge(pane) {
    pane.innerHTML =
      '<div class="head"><h2 class="headline-s">Cloudflare 优选 IP</h2></div>' +
      '<p class="sub body-m">先说清楚原理，免得白折腾：入口走哪个边缘节点是由 anycast 路由决定的，Worker 自己改不了。' +
      '能优化的只有你本机到 Cloudflare 的这一段，办法是把域名解析指向延迟更低的 CF IP。' +
      '而网关到 NVIDIA / OpenAI 这一段，本来就跑在 Cloudflare 骨干网上，不需要也没法优选。</p>' +
      '<div class="card elev"><h3 class="title-m">当前接入节点</h3>' +
      '<p class="body-m muted">探测走 <span class="mono">/cdn-cgi/trace</span>，这个路径由 Cloudflare 边缘直接响应，不会触发 Worker，不消耗你的每日请求额度。</p>' +
      '<div id="traceOut" class="chips"><span class="chip">探测中…</span></div>' +
      '<div class="row" style="margin-top:16px"><button class="btn" id="pingBtn">测 10 次延迟</button>' +
      '<button class="btn text" id="traceBtn">重新探测</button></div>' +
      '<div id="pingOut" style="margin-top:12px"></div></div>' +
      '<div class="card"><h3 class="title-m">hosts 生成器</h3>' +
      '<p class="body-m muted">用 <span class="mono">CloudflareSpeedTest</span> 之类的工具在本机测出低延迟 IP 后，粘进来生成 hosts 行。' +
      '注意：hosts 只对自定义域名有效，<span class="mono">*.pages.dev</span> 和 <span class="mono">*.workers.dev</span> 因为要走 Cloudflare 的 SNI 校验，改 hosts 通常没用。</p>' +
      '<div class="field"><label for="hDomain">你的自定义域名</label><input id="hDomain" class="mono" value="' + esc(location.hostname) + '"></div>' +
      '<div class="field"><label for="hIps">优选 IP（每行一个）</label><textarea id="hIps" placeholder="104.16.0.1&#10;172.64.0.1"></textarea></div>' +
      '<div class="row"><button class="btn tonal" id="genHosts">生成</button></div>' +
      '<pre class="code" id="hostsOut" style="margin-top:12px;display:none"></pre></div>' +
      '<div class="card outlined"><h3 class="title-m">怎么测</h3>' +
      '<p class="body-m">Cloudflare 官方 IP 段：<span class="mono">https://www.cloudflare.com/ips-v4</span>（v6 把 v4 换成 v6）。' +
      '本机跑 CloudflareSpeedTest 拿到延迟最低的几个 IP，写进 hosts 或者代理软件的分流规则里。' +
      '如果用的是 <span class="mono">*.pages.dev</span>，想优选就得先绑一个自己的域名。</p></div>';

    async function trace() {
      var out = $('#traceOut');
      out.innerHTML = '<span class="chip">探测中…</span>';
      try {
        var t0 = performance.now();
        var res = await fetch('/cdn-cgi/trace?_=' + Date.now(), { cache: 'no-store' });
        var ms = Math.round(performance.now() - t0);
        var txt = await res.text();
        var kv = {};
        txt.split('\n').forEach(function (line) {
          var i = line.indexOf('=');
          if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
        });
        out.innerHTML = '<span class="chip pri">机房 ' + esc(kv.colo || '未知') + '</span>' +
          '<span class="chip">你的出口 IP ' + esc(kv.ip || '?') + '</span>' +
          '<span class="chip">地区 ' + esc(kv.loc || '?') + '</span>' +
          '<span class="chip">' + ms + 'ms</span>' +
          '<span class="chip">' + esc(kv.http || '') + '</span>';
      } catch (e) {
        out.innerHTML = '<span class="chip err">探测失败：' + esc(e.message) + '</span>';
      }
    }

    $('#traceBtn').onclick = trace;
    $('#pingBtn').onclick = async function () {
      var btn = this; btn.disabled = true;
      var times = [];
      for (var i = 0; i < 10; i++) {
        var t0 = performance.now();
        try { await fetch('/cdn-cgi/trace?_=' + Math.random(), { cache: 'no-store' }); times.push(performance.now() - t0); }
        catch (e) { /* 忽略单次失败 */ }
      }
      btn.disabled = false;
      if (!times.length) { $('#pingOut').innerHTML = '<div class="banner">全部失败。</div>'; return; }
      times.sort(function (a, b) { return a - b; });
      var min = Math.round(times[0]);
      var med = Math.round(times[Math.floor(times.length / 2)]);
      var max = Math.round(times[times.length - 1]);
      $('#pingOut').innerHTML = '<div class="chips"><span class="chip ok">最快 ' + min + 'ms</span>' +
        '<span class="chip pri">中位 ' + med + 'ms</span><span class="chip">最慢 ' + max + 'ms</span>' +
        '<span class="chip">样本 ' + times.length + '</span></div>' +
        '<p class="body-s muted" style="margin-top:8px">中位数低于 120ms 基本没有优化空间；高于 250ms 或者波动很大，换 IP 通常能明显改善。</p>';
    };
    $('#genHosts').onclick = function () {
      var domain = ($('#hDomain').value || '').trim();
      var ips = ($('#hIps').value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!domain || !ips.length) return toast('域名和 IP 都要填');
      var out = $('#hostsOut');
      out.style.display = 'block';
      out.textContent = '# LLM Gateway 优选 IP\n' + ips.map(function (ip) { return ip + '\t' + domain; }).join('\n') +
        '\n\n# Windows: C:\\Windows\\System32\\drivers\\etc\\hosts\n# macOS / Linux: /etc/hosts\n# 只保留一行生效，多行会由系统自行选择。';
    };
    trace();
  }

  // ---------- 对话框 ----------

  function mkDialog(title, inner, okLabel) {
    var dlg = document.createElement('dialog');
    var onlyClose = okLabel === '关闭';
    dlg.innerHTML = '<h3 class="title-l">' + title + '</h3><div class="dlgBody">' + inner + '</div>' +
      '<div class="actions">' +
      (onlyClose ? '' : '<button class="btn text" id="dlgCancel">取消</button>') +
      '<button class="btn" id="dlgOk">' + esc(okLabel || '确定') + '</button></div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    if (onlyClose) $('#dlgOk', dlg).onclick = function () { dlg.close(); dlg.remove(); };
    else $('#dlgCancel', dlg).onclick = function () { dlg.close(); dlg.remove(); };
    dlg.addEventListener('close', function () { setTimeout(function () { dlg.remove(); }, 0); });
    return dlg;
  }

  try {
    var saved = localStorage.getItem('gw-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
  } catch (e) {}

  boot();
}

// ---------- src/ui/html.js ----------
// 整个后台就是一个 HTML 文档，CSS/JS 全内联，浏览器只发一次请求。
// 单独引 css/js 文件的话每次开面板要多花 2 次 Worker 请求，免费额度是按请求数算的。


const FAVICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%9B%B0%EF%B8%8F%3C/text%3E%3C/svg%3E';

function renderAdminPage() {
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<title>LLM Gateway 控制台</title>\n' +
    '<link rel="icon" href="' + FAVICON + '">\n' +
    '<style>' + UI_CSS + '</style>\n' +
    '</head>\n<body>\n<div id="root"></div>\n<div id="snack" role="status" aria-live="polite"></div>\n' +
    '<script>(' + uiApp.toString() + ')();<' + '/script>\n' +
    '</body>\n</html>'
  );
}

function renderLanding(origin) {
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>LLM Gateway</title><link rel="icon" href="' + FAVICON + '">' +
    '<style>' + UI_CSS + '</style></head><body>' +
    '<div class="login"><div class="card elev">' +
    '<div class="logo">🛰️</div><h1 class="headline-s">LLM Gateway</h1>' +
    '<p class="body-m muted" style="margin:8px 0 20px">OpenAI 兼容的多模型聚合网关，跑在 Cloudflare 上。</p>' +
    '<pre class="code" style="text-align:left">' + origin + '/v1/chat/completions</pre>' +
    '<div style="margin-top:20px"><a class="btn" href="/admin" style="text-decoration:none;justify-content:center;width:100%">打开控制台</a></div>' +
    '</div></div></body></html>'
  );
}

// ---------- src/routes/openai.js ----------
// 对外的 OpenAI 兼容接口。
// 客户端把 base_url 指到 https://你的域名/v1 就能直接用。


const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
const COMPLETION_PATHS = new Set(['/v1/completions', '/completions']);
const EMBEDDING_PATHS = new Set(['/v1/embeddings', '/embeddings']);
const MODEL_PATHS = new Set(['/v1/models', '/models']);

function isOpenAiPath(pathname) {
  return (
    CHAT_PATHS.has(pathname) ||
    COMPLETION_PATHS.has(pathname) ||
    EMBEDDING_PATHS.has(pathname) ||
    MODEL_PATHS.has(pathname) ||
    pathname.startsWith('/v1/models/')
  );
}

async function handleOpenAI(request, env, ctx, url) {
  const pathname = url.pathname;
  if (request.method === 'OPTIONS') return preflight();

  const config = await loadConfig(env);
  // 顺手看一眼要不要把内存里的用量批量落一次 KV（有间隔限制，不会每次都写）
  maybeFlushUsage(env, ctx, config.settings);

  // ---- 模型列表 ----
  if (MODEL_PATHS.has(pathname) || pathname.startsWith('/v1/models/')) {
    if (request.method !== 'GET') return apiError(405, '该接口只接受 GET。');
    if (!config.settings.allowAnonymousModels) {
      const auth = await verifyGatewayKey(request, env);
      if (!auth.ok) return unauthorized(auth.reason);
      if (config.settings.trackUsage !== false) {
        recordUsage({ keyId: auth.key.id, name: auth.key.name, endpoint: 'models' });
      }
    }
    const list = buildModelList(config, { includeOwner: config.settings.exposeProviderInList !== false });

    // 单个模型详情：GET /v1/models/{id}
    if (pathname.startsWith('/v1/models/')) {
      const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const hit = list.data.find((m) => m.id === id);
      if (!hit) return apiError(404, '没有这个模型：' + id, 'invalid_request_error', 'model_not_found');
      return jsonResponse(hit);
    }
    // 让客户端缓存一分钟，少打几次 Worker。
    return jsonResponse(list, { headers: { 'Cache-Control': 'private, max-age=60' } });
  }

  // ---- 推理类接口 ----
  const isChat = CHAT_PATHS.has(pathname);
  const isCompletion = COMPLETION_PATHS.has(pathname);
  const isEmbedding = EMBEDDING_PATHS.has(pathname);
  if (!isChat && !isCompletion && !isEmbedding) {
    return apiError(404, '未实现的接口：' + pathname, 'invalid_request_error', 'not_found');
  }
  if (request.method !== 'POST') return apiError(405, '该接口只接受 POST。');

  const keys = await loadKeys(env);
  if (!keys.length) {
    return apiError(
      403,
      '网关还没有创建任何 API 密钥，请先到 /admin 创建一个再调用。',
      'no_api_keys',
      'no_keys'
    );
  }
  const auth = await verifyGatewayKey(request, env);
  if (!auth.ok) return unauthorized(auth.reason);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    return apiError(400, err.message || '请求体解析失败。');
  }
  if (isChat && !Array.isArray(body.messages)) {
    return apiError(400, 'messages 字段缺失或不是数组。');
  }

  const path = isChat ? 'chat/completions' : isCompletion ? 'completions' : 'embeddings';
  return proxyOpenAI({
    env,
    config,
    path,
    body,
    embedding: isEmbedding,
    requestId: 'gw_' + randomToken(16),
    auth: { id: auth.key.id, name: auth.key.name },
  });
}

function unauthorized(reason) {
  const message =
    reason === 'missing'
      ? '缺少 API 密钥。请在请求头里带上 Authorization: Bearer sk-gw-...'
      : reason === 'no_keys'
        ? '网关尚未创建 API 密钥。'
        : 'API 密钥无效或已被吊销。';
  return apiError(401, message, 'authentication_error', 'invalid_api_key');
}

// ---------- src/routes/anthropic.js ----------
// Anthropic Messages 协议桥接（POST /v1/messages）。
//
// 为什么需要它：Claude Code 说的是 Anthropic 的协议，不是 OpenAI 的。
// 网关内部统一走 OpenAI 格式，这一层负责进来时翻成 OpenAI、出去时翻回 Anthropic，
// 中间复用同一条故障转移链。
//
// 覆盖范围：文本、图片输入、system、tools / tool_use / tool_result、流式。
// 不覆盖：extended thinking、citations、文档块、prompt caching —— 这些没有 OpenAI 对应物。


const ANTHROPIC_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

function isAnthropicPath(pathname) {
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

function anthropicToOpenAI(body) {
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

function openAIToAnthropic(payload, modelName) {
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
function streamOpenAIToAnthropic(readable, modelName) {
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

async function handleAnthropic(request, env, ctx, url) {
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

// ---------- src/routes/admin.js ----------
// 后台接口。所有路径都在 /admin/api/ 下，除登录外一律要求会话 Cookie。


async function handleAdminApi(request, env, ctx, url) {
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

// ---------- src/index.js ----------
// 入口。Worker 和 Pages Functions 用的是同一份代码。
//
// 省请求数的几个地方：
//  - 后台是单个 HTML 文档，CSS/JS 全内联 —— 打开面板只算 1 次请求，不是 3 次。
//  - favicon 直接用内联 data URI，浏览器不会再单独去要一次。
//  - /robots.txt 和 /favicon.ico 给极短响应，不落到业务逻辑。
//  - 首页伪装的回源结果走边缘缓存，重复访问基本不用醒 Worker。
//  - /v1/models 带 Cache-Control，客户端一分钟内不会反复来问。
//  - 上游调用是子请求，Cloudflare 不计入请求数，所以故障转移本身不花额度。


export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (!env || env.SILENCE_ERRORS !== '1') console.error('gateway error:', message);
      return apiError(500, '网关内部错误：' + message, 'server_error');
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return preflight();

  if (path === '/favicon.ico') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=604800' } });
  }
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' },
    });
  }
  if (path === '/healthz') {
    return jsonResponse({ ok: true, kv: hasKv(env), ts: Date.now() });
  }

  if (path === '/admin/api' || path.startsWith('/admin/api/')) {
    return handleAdminApi(request, env, ctx, url);
  }
  if (path === '/admin') {
    return htmlResponse(renderAdminPage());
  }

  if (isAnthropicPath(path)) {
    return handleAnthropic(request, env, ctx, new URL(url.origin + path + url.search));
  }

  if (isOpenAiPath(path)) {
    return handleOpenAI(request, env, ctx, new URL(url.origin + path + url.search));
  }

  // 首页伪装：环境变量 url 指向哪个站点，根路径就显示那个站点的首页。
  // 没设默认伪装成 www.bing.com；设成 off 则显示网关自带落地页。
  const masquerade = disguiseTarget(env);

  if (path === '/') {
    if (!masquerade) return htmlResponse(renderLanding(url.origin));
    return serveDisguise(masquerade, request);
  }

  // 开了伪装就别在 404 里把网关的存在抖出去；接口路径仍然返回可读的错误。
  if (masquerade && !path.startsWith('/v1') && !path.startsWith('/admin')) {
    return neutralNotFound();
  }

  return apiError(404, '没有这个路径：' + path + '。OpenAI 接口在 /v1/chat/completions，Anthropic 接口在 /v1/messages，控制台在 /admin。', 'invalid_request_error', 'not_found');
}
