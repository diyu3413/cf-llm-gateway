// 各大 LLM 服务商预设。全部要求兼容 OpenAI 的
// GET  {baseUrl}/models              -> 模型列表
// POST {baseUrl}/chat/completions    -> 对话补全
// 若服务商原生不是 OpenAI 格式（如 Gemini 原生 API），这里统一填写其官方
// 提供的 "OpenAI 兼容层" 地址，因此可以用完全一致的方式调用。

export const PROVIDER_PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    docs: "https://platform.openai.com/docs",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docs: "https://api-docs.deepseek.com/",
  },
  {
    id: "gemini",
    name: "Google Gemini (OpenAI 兼容层)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docs: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    docs: "https://build.nvidia.com/",
  },
  {
    id: "qwen",
    name: "阿里云通义千问 (DashScope 兼容模式)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docs: "https://help.aliyun.com/zh/dashscope/",
  },
  {
    id: "mimo",
    name: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    docs: "https://xiaomimimo.com/",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    docs: "https://platform.moonshot.cn/docs",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docs: "https://open.bigmodel.cn/dev/api",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    docs: "https://console.groq.com/docs",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    docs: "https://docs.mistral.ai/",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    docs: "https://docs.together.ai/",
  },
  {
    id: "custom",
    name: "自定义 (Custom OpenAI 兼容接口)",
    baseUrl: "",
    docs: "",
  },
];

export function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}
