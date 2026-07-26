// 对外的 OpenAI 兼容接口。
// 客户端把 base_url 指到 https://你的域名/v1 就能直接用。

import { jsonResponse, apiError, preflight, readJsonBody } from '../lib/http.js';
import { verifyGatewayKey } from '../lib/auth.js';
import { loadConfig, loadKeys } from '../lib/config.js';
import { proxyOpenAI, buildModelList } from '../lib/proxy.js';
import { randomToken } from '../lib/crypto.js';
import { recordUsage, maybeFlushUsage } from '../lib/usage.js';

const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
const COMPLETION_PATHS = new Set(['/v1/completions', '/completions']);
const EMBEDDING_PATHS = new Set(['/v1/embeddings', '/embeddings']);
const MODEL_PATHS = new Set(['/v1/models', '/models']);

export function isOpenAiPath(pathname) {
  return (
    CHAT_PATHS.has(pathname) ||
    COMPLETION_PATHS.has(pathname) ||
    EMBEDDING_PATHS.has(pathname) ||
    MODEL_PATHS.has(pathname) ||
    pathname.startsWith('/v1/models/')
  );
}

export async function handleOpenAI(request, env, ctx, url) {
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
