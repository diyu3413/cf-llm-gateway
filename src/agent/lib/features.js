// 【覆盖实现】内嵌特性：embedded=true，模型列表来自网关「模型链」页配置。
// 本文件只存在于合并部署；独立部署的原始版本在 cf-agent-web 仓库，
// 同步脚本（scripts/sync-agent.mjs）刻意不覆盖这里。
// 签名与独立版一致：agentFeatures(env) => { embedded, models: [{id, kind}], defaultModel }

import { loadConfig } from '../../lib/config.js';

export async function agentFeatures(env) {
  if (!env.KV) return { embedded: false, models: [], defaultModel: '' };
  const config = await loadConfig(env);
  const models = config.models
    .filter((m) => m.enabled !== false)
    .map((m) => ({ id: m.alias, kind: m.kind || 'chat' }));
  const def = config.models.find((m) => m.id === config.defaultModel);
  return { embedded: true, models, defaultModel: def ? def.alias : 'auto' };
}
