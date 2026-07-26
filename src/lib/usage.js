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

import { hasKv } from './config.js';

export const USAGE_KEY = 'gw:usage';

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

export function countCjk(str) {
  const m = String(str || '').match(CJK_RE);
  return m ? m.length : 0;
}

export function estimateFromCounts(chars, cjk) {
  const c = Math.max(0, Number(chars) || 0);
  const k = Math.min(c, Math.max(0, Number(cjk) || 0));
  return Math.ceil(k / 1.5 + (c - k) / 4);
}

export function estimateTokens(input) {
  if (!input) return 0;
  let str = typeof input === 'string' ? input : JSON.stringify(input);
  if (!str) return 0;
  if (str.length > ESTIMATE_CHAR_CAP) str = str.slice(0, ESTIMATE_CHAR_CAP);
  return estimateFromCounts(str.length, countCjk(str));
}

// ---------- 记账 ----------

export function recordUsage(entry) {
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

export function pendingUsageEvents() {
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

export async function flushUsage(env, { force = false, intervalSeconds = DEFAULT_FLUSH_SECONDS } = {}) {
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

export function maybeFlushUsage(env, ctx, settings) {
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

export async function resetUsage(env) {
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
export async function usageSnapshot(env, keyRecords, settings) {
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

export function usageFromJson(obj) {
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
export function meterBody(readable, { stream, onDone }) {
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
