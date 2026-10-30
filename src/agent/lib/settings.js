// 配置存 D1 的 settings 表（k/v），面板可改。网关地址/密钥/模型都在这里配，
// 改完即时生效 —— 不像环境变量要重新部署。

export const DEFAULT_AGENT_SETTINGS = {
  gatewayBaseUrl: '', // 例如 https://your-gateway.workers.dev ；空则 agent 不可用
  gatewayKey: '', // 网关密钥 sk-gw-...，只在保存时可见，读接口永远只给掩码
  model: 'auto', // 网关里的模型别名；auto/default 走网关默认链
  systemPrompt: '', // 附加系统提示；工作区说明由 prompts.js 自动生成，不需要在这里重复
  maxToolCalls: 12, // 单轮回复最多执行几次工具，超出强制总结（免费版 50 子请求/次的护栏）
  maxHistoryChars: 96_000, // 会话上下文按字符数裁剪的上限
  readMaxChars: 48_000, // 单次读文件最多回给模型的字符数
  writeMaxChars: 400_000, // 单个文件写入上限（字符）
  scheduleEnabled: true, // 是否允许 agent 用 schedule_task 定时唤醒自己
  webSearchUrl: '', // Tavily 兼容搜索端点（POST {query} → {results:[{title,url,content}]}）；空 = 关闭 web_search
  webSearchKey: '', // 搜索 API Key（Tavily 是 tvly- 开头），读接口只给掩码
  webFetchEnabled: true, // web_fetch 抓取网页开关（Worker 原生抓取，独立于搜索配置）
};

const SETTINGS_KEY = 'agent';

export async function getSettings(db) {
  const out = { ...DEFAULT_AGENT_SETTINGS };
  try {
    const { results } = await db.prepare('SELECT k, v FROM settings').all();
    for (const row of results || []) {
      if (row.k in out) out[row.k] = row.v;
    }
  } catch {
    /* 表还没建（没跑 migration）就先用默认值 */
  }
  // 数值字段从 D1 读出来是字符串，转回来；布尔同理（'false' 字符串 !== false，必须归一）
  for (const k of ['maxToolCalls', 'maxHistoryChars', 'readMaxChars', 'writeMaxChars']) {
    out[k] = Number(out[k]) || DEFAULT_AGENT_SETTINGS[k];
  }
  for (const k of ['scheduleEnabled', 'webFetchEnabled']) {
    out[k] = out[k] !== 'false' && out[k] !== false;
  }
  return out;
}

export async function saveSettings(db, patch) {
  const merged = { ...(await getSettings(db)) };
  for (const k of Object.keys(DEFAULT_AGENT_SETTINGS)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (typeof DEFAULT_AGENT_SETTINGS[k] === 'number') {
      v = Math.round(Number(v));
      if (!Number.isFinite(v)) continue;
    } else {
      v = String(v == null ? '' : v);
    }
    merged[k] = v;
  }
  merged.maxToolCalls = Math.min(40, Math.max(1, merged.maxToolCalls));
  merged.maxHistoryChars = Math.min(400_000, Math.max(8_000, merged.maxHistoryChars));
  merged.readMaxChars = Math.min(200_000, Math.max(2_000, merged.readMaxChars));
  merged.writeMaxChars = Math.min(2_000_000, Math.max(1_000, merged.writeMaxChars));

  const stmts = Object.keys(DEFAULT_AGENT_SETTINGS).map((k) =>
    db
      .prepare(
        'INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2'
      )
      .bind(k, String(merged[k]))
  );
  await db.batch(stmts);
  return merged;
}

// 面板永远拿不到网关密钥明文，只能看到掩码；保存时空值/掩码回传视为"不修改"。
export function redactSettings(s) {
  const key = s.gatewayKey || '';
  const webKey = s.webSearchKey || '';
  return {
    ...s,
    gatewayKey: undefined,
    hasKey: Boolean(key),
    keyMask: key ? key.slice(0, 8) + '****' + key.slice(-4) : '',
    webSearchKey: undefined,
    hasWebKey: Boolean(webKey),
    webKeyMask: webKey ? webKey.slice(0, 6) + '****' + webKey.slice(-4) : '',
  };
}

// 掩码回传识别：包含 **** 的一律当"没改"处理。
export function isMaskedKey(v) {
  return typeof v === 'string' && v.includes('****');
}
