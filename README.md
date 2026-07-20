# cf-llm-gateway
把多家大模型服务商（NVIDIA NIM/Google Gemini/OpenAI等）的API Key汇聚到Cloudflare Worker/Pages项目里， 对外统一暴露一个新的、随时可重置的 API Key，同时提供OpenAI和Anthropic两种标准接口格式，可直接接入Claude Code、AstrBot等任何第三方项目;并借助cf全球边缘网络，帮你访问在国内被wall的模型服务商。

## 功能一览

| 功能                 | 说明                                                         |
| -------------------- | ------------------------------------------------------------ |
| 多服务商聚合         | 内置 OpenAI / DeepSeek / Gemini（官方 OpenAI 兼容层）/ NVIDIA NIM / 通义千问 / MiMo / Moonshot / 智谱 / Groq / Mistral / OpenRouter / Together 等预设，也支持任意自定义 OpenAI 兼容接口 |
| 模型搜索导入         | 填入 Base URL + API Key 后点击"搜索模型"，调用该服务商 `GET /models` 拉取真实可用模型列表，同一模型下的不同版本（如 pro / flash）各自独立导入，逐个启用并标注多模态能力（视觉/音频/工具调用） |
| 双协议对外接口       | `POST /v1/chat/completions`、`GET /v1/models`（OpenAI 格式）与 `POST /v1/messages`（Anthropic 格式，自动做请求/响应/流式 SSE 互转），供不同客户端按需接入 |
| 按顺序故障转移       | 请求不指定模型（或 `auto`）时，按后台设定的服务商顺序依次尝试其默认模型，第一个调用成功立即返回并停止后续尝试；全部失败返回 `403` |
| `/admin` 管理面板    | Material Design 3 风格单页应用，登录、增删服务商、拖动排序、搜索导入模型、设置默认模型、生成 Key|
| 节省免费额度         | KV 读取带内存缓存；管理员会话用 HMAC 无状态签名 token（零 KV 消耗）；密钥使用记录节流写入 |
| 双部署方式           | 同一套源码既可以用 `wrangler` 以 Workers 方式部署，也可以打包成单文件 `_worker.js` 用于 Pages |

## 目录结构

```
cf-llm-gateway/
├─ src/
│  ├─ index.js            # Worker 入口 / 路由
│  ├─ lib/
│  │  ├─ utils.js          # 通用工具（JSON响应、CORS、哈希、随机Key等）
│  │  ├─ kv.js              # KV 读写 + 内存缓存
│  │  ├─ auth.js            # 管理员会话 / 对外 API Key 校验（支持 Bearer 与 x-api-key）
│  │  ├─ providers.js       # 各大模型服务商预设 base URL
│  │  ├─ proxy.js           # 核心：模型聚合、按顺序故障转移调用（OpenAI 格式入口）
│  │  └─ anthropic.js       # Anthropic Messages 格式 ⇄ OpenAI 格式互转（含流式 SSE）
│  └─ admin/
│     └─ html.js            # /admin 管理面板页面（Material Design 3）
├─ wrangler.toml
├─ package.json
└─ LICENSE (MIT)
```

## 部署方式一：Cloudflare Workers（推荐，git 直接导入）

1. Fork / push 本项目到你自己的 GitHub 仓库。
2. Cloudflare Dashboard → Workers & Pages → Create → Workers → **Import a repository**，选择该仓库。
3. 创建 KV 命名空间：Workers & Pages → KV → Create namespace，随便起名（例如 `llm-gateway-kv`）。
4. 回到该 Worker → Settings → Bindings → 添加 **KV Namespace binding**：
   - Variable name: `KV`（必须完全一致）
   - 选择刚创建的命名空间
5. Settings → Variables and Secrets → 添加变量：
   - Name: `admin_password`，Type 选 **Text**（或用 Secret 更安全），值为你自定义的管理密码
6. 部署完成后访问：
   - API: `https://你的worker子域.workers.dev/v1/chat/completions`
   - 管理面板: `https://你的worker子域.workers.dev/admin`
7. 如需自定义域名，在 Worker → Triggers → Custom Domains 里添加即可，API 地址随之变为
   `https://你的域名/v1/chat/completions`。

也可以本地用 wrangler 直接发布：

```bash
npm install
npx wrangler kv namespace create KV   # 记下返回的 id，填入 wrangler.toml
npx wrangler secret put admin_password
npx wrangler deploy
```

## 部署方式二：Cloudflare Pages（`_worker.js` 单文件）

Pages 的 git 集成不会执行 `wrangler.toml` 里的绑定，需要在打包出单文件后，在 Pages 项目
设置里手动添加 KV 绑定和变量。

1. 本地打包：

```bash
npm install
npm run build:pages   # 生成项目根目录下的 _worker.js
```

2. 把仓库（含生成的 `_worker.js`）push 到 GitHub，Cloudflare Dashboard → Workers & Pages
   → Create → Pages → 连接该仓库。构建命令留空或填 `npm run build:pages`，输出目录填 `/`
   （根目录，因为 `_worker.js` 直接放在根目录会被 Pages 自动识别为 Functions 入口）。
3. Pages 项目 → Settings → Functions → **KV namespace bindings**：
   - Variable name: `KV`，选择你创建的 KV 命名空间
4. Pages 项目 → Settings → Environment variables：
   - 添加 `admin_password`（Production 和 Preview 都建议设置）
5. 部署完成后地址形如 `https://你的项目.pages.dev`，同样支持绑定自定义域名。

（也可以选择`Releases`下载`_worker.zip`文件，使用本地上传的方式来进行部署，推荐本地上传方法）

> 说明：`_worker.js` 是 esbuild 把 `src/` 下所有 ES module 打包成的单文件产物，逻辑与
> Workers 版完全一致，因此两种部署方式功能完全对等，任选其一即可。

## 使用步骤

1. 打开 `https://你的域名/admin`，用 `admin_password` 登录。
2. 在"服务商 / 模型"卡片里点击"添加服务商"，选择预设模板（DeepSeek / NVIDIA / Gemini /
   通义千问 / MiMo 等，切换模板时显示名称和 Base URL 会自动跟随）或选"自定义"，填入 Base
   URL 和该服务商的 API Key，保存。
3. 点击该服务商卡片上的"搜索模型"，会调用其 `GET /models` 接口拉取真实可用模型列表并导入
   （比如同时出现 `deepseek-chat`、`deepseek-reasoner` 等），逐个勾选启用，并可以给每个模型
   手动打开/关闭 视觉、音频、工具调用 标签。
4. 用左侧的上下箭头调整服务商的调用优先级顺序；用单选框设置该服务商的"默认调用模型"。
5. 在"对外 API Key"卡片里点击"生成新密钥"：
   - 第一步会弹出命名弹窗，**必须填写备注**才能继续（留空点击"下一步"会提示"请输入密钥备注"）
   - 填写后自动跳转到第二个弹窗，完整显示生成的密钥（仅这一次），点击"复制"按钮即可复制到剪贴板
6. 把下面两组信息填到 Claude Code / AstrBot 等项目的"自定义 OpenAI / Anthropic 服务"配置里
   （两种格式的具体 Base URL 也能在"接入方式"卡片里直接复制）：
   - OpenAI 兼容：Base URL `https://你的域名/v1`，`Authorization: Bearer <key>`
   - Anthropic 兼容（Claude Code 等）：`ANTHROPIC_BASE_URL=https://你的域名`，
     `ANTHROPIC_AUTH_TOKEN=<key>`
   - 模型：可以留空/填 `auto`（自动按顺序故障转移），也可以先请求 `GET /v1/models` 拿到形如
     `deepseek/deepseek-chat` 的具体模型 id 直接指定。


## 两种对外协议格式

| 协议           | 接口路径                                      | Base URL 填法                                                | 鉴权方式                      | 典型客户端                              |
| -------------- | --------------------------------------------- | ------------------------------------------------------------ | ----------------------------- | --------------------------------------- |
| OpenAI 兼容    | `POST /v1/chat/completions`、`GET /v1/models` | `https://你的域名/v1`                                        | `Authorization: Bearer <key>` | AstrBot、大多数第三方 OpenAI 客户端     |
| Anthropic 兼容 | `POST /v1/messages`                           | `https://你的域名`（不带 `/v1`，客户端会自动拼 `/v1/messages`） | `x-api-key: <key>`            | Claude Code 等原生 Anthropic 协议客户端 |

网关本身对这两种鉴权头都兼容，用哪个都能通过。`/v1/messages` 内部会把 Anthropic 请求体
（含 `system`、多模态 `content` 数组、`tools`/`tool_choice`、流式 `stream: true`）转换为
OpenAI chat-completions 格式，调用同一条按顺序故障转移的服务商链路，再把响应（含 SSE
流式事件）转换回 Anthropic 的 `message_start` / `content_block_delta` / `message_stop`
等事件格式返回。

Claude Code 接入示例：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_AUTH_TOKEN="sk-cfg-…（在 /admin 生成的密钥）"
claude
```

## 调用行为说明

- 请求 `model` 字段为空、`auto`，或者不匹配任何已导入模型时：按照后台设置的服务商顺序，
  依次使用每个服务商的"默认调用模型"发起请求；第一个成功（HTTP 2xx）的立即返回结果并
  停止后续尝试；全部失败则返回 `403 all_models_unavailable`。
- 请求 `model` 字段是一个已知的具体模型 id（如 `deepseek/deepseek-chat`，可从
  `GET /v1/models` 获取）：只调用这一个模型，不做故障转移，失败会把上游错误原样透传。

## License

本项目依 MIT 许可证条款授权
