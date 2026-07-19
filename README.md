# cf-llm-gateway
把多家大模型服务商（NVIDIA NIM/Google Gemini/OpenAI等）的API Key汇聚到Cloudflare Worker/Pages项目里， 对外统一暴露一个新的、随时可重置的 API Key，同时提供OpenAI和Anthropic两种标准接口格式，可直接接入Claude Code、AstrBot等任何第三方项目；并借助cf全球边缘网络，帮你访问在国内被wall的模型服务商。
