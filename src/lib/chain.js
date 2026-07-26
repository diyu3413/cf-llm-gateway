// 逐层调用链。
//
// 需求：按添加顺序从上往下试，第一个能通的就用它，之后不再往后试；全挂返回 403。
//
// 实现要点：不做"先探活再调用"那种两段式 —— 那会让每个模型消耗两个子请求。
// 直接发真实请求，收到非 2xx 或网络异常就顺延到下一个，这本身就是最准确的连通性判定。
// 失败的模型进内存冷却表，冷却期内直接跳过，连子请求都不发。

const cooldown = new Map(); // modelId -> { until, status, message }

export function isCoolingDown(modelId) {
  const rec = cooldown.get(modelId);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    cooldown.delete(modelId);
    return false;
  }
  return true;
}

export function getCooldown(modelId) {
  const rec = cooldown.get(modelId);
  if (!rec || Date.now() > rec.until) return null;
  return rec;
}

export function markFailure(modelId, seconds, status, message) {
  if (!seconds || seconds <= 0) return;
  cooldown.set(modelId, {
    until: Date.now() + seconds * 1000,
    status: status || 0,
    message: String(message || '').slice(0, 200),
    at: Date.now(),
  });
}

export function clearFailure(modelId) {
  cooldown.delete(modelId);
}

export function clearAllFailures() {
  cooldown.clear();
}

export function cooldownSnapshot() {
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

export function findModelByName(config, name) {
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
export function buildCandidates(config, requestedModel, opts = {}) {
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

export function providerOf(config, model) {
  return config.providers.find((p) => p.id === model.providerId) || null;
}
