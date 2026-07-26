// 提供商预设。baseUrl 均为"OpenAI 兼容"端点，即在其后拼 /chat/completions、/models。
// 注意：厂商随时可能调整地址，面板里所有字段都可手工改，预设只是省事用的。
// authStyle: bearer(默认) | api-key | x-api-key | custom

export const PROVIDER_PRESETS = [
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

export function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

// 去掉结尾斜杠再拼接，避免出现 //chat/completions 这种被某些网关 404 的地址。
export function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return b + '/' + p;
}

export function buildAuthHeaders(provider) {
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
