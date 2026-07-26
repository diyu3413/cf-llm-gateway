// 模型搜索：拿 provider 的 key 去打上游 /models，把能用的模型列出来。
// 一次搜索 = 1 个外部子请求，不算 Worker 请求数。

import { joinUrl, buildAuthHeaders } from './presets.js';
import { guessModelMeta } from './caps.js';

export function normalizeModelList(payload) {
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

export async function discoverModels(provider, { timeoutMs = 20000 } = {}) {
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
