# cf-llm-gateway

把多家大模型服务商（NVIDIA NIM / Google Gemini / OpenAI 等）的 API Key 汇聚到 Cloudflare Pages 项目里，对外统一暴露一个新的、随时可重置的 API Key，同时提供 OpenAI 和 Anthropic 两种标准接口格式，可直接接入 Claude Code、AstrBot 等任何第三方项目；并借助 CF 全球边缘网络，帮你访问在国内被 wall 的模型服务商。

> **2026-10 更新**：在原有网关能力之外，新增了**内嵌文件工作区 Agent（demo）**与明确的**双轨部署**（Workers 全功能版 / Pages 纯网关版），另有一批安全与体验加固（admin CORS 收紧、流中途错误收口、单密钥限速、MD3 设计令牌统一）。原有网关功能与部署流程完全不受影响，详见[部署方式](#部署方式)与[内嵌 Agent（demo）](#内嵌-agentdemo)。

## 目录

- [功能一览](#功能一览)
- [目录结构](#目录结构)
- [部署方式](#部署方式)
- [内嵌 Agent（demo）](#内嵌-agentdemo)
- [使用步骤](#使用步骤)
- [对外协议格式](#对外协议格式)
- [调用行为说明](#调用行为说明)
- [用量统计](#用量统计)
- [伪装域名](#伪装域名)
- [优选 IP](#优选IP)
- [安全](#安全)
- [本地开发](#本地开发)
- [Anotherquestions](#Anotherquestions)
- [License](#License)

## 功能一览

| 功能              | 说明                                                         |
| ----------------- | ------------------------------------------------------------ |
| 多服务商聚合      | 内置 OpenAI / DeepSeek / Gemini（官方 OpenAI 兼容层）/ NVIDIA NIM / 通义千问（国内+国际）/ MiMo / Moonshot / 智谱 / MiniMax（国内+国际）/ 硅基流动 / 魔搭 / 火山方舟 / Groq / xAI / Mistral / Together / Cerebras / OpenRouter 等 20+ 预设，也支持任意自定义 OpenAI 兼容接口 |
| 模型搜索导入      | 填入 Base URL + API Key 后点击"搜索模型"，调用该服务商 `GET /models` 拉取真实可用模型列表，同一系列下的不同版本（如 pro / flash）各自独立导入，逐个勾选启用并标注多模态能力（视觉 / 音频 / 视频 / 工具调用 / 推理） |
| 双协议对外接口    | `POST /v1/chat/completions`、`GET /v1/models`（OpenAI 格式）与 `POST /v1/messages`、`POST /v1/messages/count_tokens`（Anthropic 格式，自动做请求/响应/流式 SSE 互转），供不同客户端按需接入 |
| 按顺序故障转移    | 按后台设定的模型顺序依次尝试，第一个调用成功立即返回并停止后续尝试；全部失败返回 `403`。失败的模型进冷却表，冷却期内直接跳过、连请求都不发 |
| 识破流内错误      | 有些上游返回 HTTP 200，错误却藏在 SSE 第一个事件里。网关会预读首块，是错误就无感转到下一个模型 |
| 用量统计          | 按对外 API Key 记录调用次数与 token 消耗，可按模型、按接口下钻。内存累加 + 定时批量落 KV，不吃写额度 |
| 首页伪装          | 环境变量 `url` 指定一个站点，访问根路径时显示该站点首页，从外面看不出这是个网关 |
| `/admin` 管理面板 | Material Design 3 风格单页应用，登录、增删服务商、调整调用顺序、搜索导入模型、设置默认模型、生成 Key、看用量。 |
| 节省免费额度      | 转发热路径**永不写 KV**；KV 读带内存缓存 + 边缘缓存；管理员会话用 HMAC 无状态签名 token（零 KV 消耗）；用量记录节流写入；面板单文档全内联，打开一次只算 1 次请求 |
| 双部署方式        | 同一套源码既可以用 `wrangler` 以 Workers 方式部署，也可以打包成单文件 `_worker.js` 用于 Pages |
| 内嵌 Agent（demo） | Workers 合并版独有：`/agent` 提供以 R2 为工作区的文件 agent（读写/编辑/检索/定时任务/联网搜索抓取），模型直连网关调用链免配置。纯 Pages 网关版不含此功能，详见[内嵌 Agent（demo）](#内嵌-agentdemo) |

## 目录结构

```
cf-llm-gateway/
├─ src/
│  ├─ index.js              # Worker 入口 / 路由（纯网关；Pages 产物从这里打包）
│  ├─ combined.js           # 合并版入口：网关 + 内嵌 Agent（Workers 轨道的 main）
│  ├─ lib/
│  │  ├─ crypto.js          # 哈希 / HMAC / 随机 Key
│  │  ├─ http.js            # JSON 响应、CORS、OpenAI 错误结构
│  │  ├─ presets.js         # 各大模型服务商预设 base URL 与鉴权方式
│  │  ├─ caps.js            # 按模型名推断多模态能力
│  │  ├─ config.js          # KV 读写 + 内存缓存
│  │  ├─ usage.js           # 用量统计、token 估算、响应体计量
│  │  ├─ disguise.js        # 首页伪装（环境变量 url）
│  │  ├─ auth.js            # 管理员会话 / 对外 API Key 校验（支持 Bearer 与 x-api-key）
│  │  ├─ discovery.js       # 拉取上游 /models
│  │  ├─ chain.js           # 调用顺序、冷却表
│  │  └─ proxy.js           # 核心：模型聚合、按顺序故障转移调用、流式回写
│  ├─ routes/
│  │  ├─ openai.js          # /v1/chat/completions、/v1/models 等
│  │  ├─ anthropic.js       # Anthropic Messages 格式 ⇄ OpenAI 格式互转（含流式 SSE）
│  │  └─ admin.js           # /admin 后台 JSON 接口
│  ├─ agent/                # 内嵌 Agent（cf-agent-web 的同步拷贝，勿手改；两个覆盖实现除外）
│  │  ├─ index.js           # agent 路由（合并版挂在 /agent 下）
│  │  ├─ do/session.js      # 每会话一个 Durable Object：历史/WS/定时任务
│  │  ├─ lib/               # 工作区工具、agent 循环、SSE、设置……
│  │  │  ├─ fetchchat.js    # 【覆盖实现】内嵌模型通道：直调网关 runChain
│  │  │  └─ features.js     # 【覆盖实现】内嵌特性：模型列表来自「模型链」
│  │  └─ ui/                # agent 前端（与网关共用 tokens.js 的拷贝）
│  └─ ui/
│     ├─ tokens.js          # MD3 设计令牌（颜色/形状/高度/动效；与 cf-agent-web 共用的拷贝，改动需两边同步）
│     ├─ css.js             # Material Design 3 样式（含移动端抽屉、动效）
│     ├─ app.js             # 管理面板前端，构建时整个内联进 HTML
│     └─ html.js            # 页面骨架
├─ migrations/              # agent 的 D1 建表迁移（纯网关轨道用不到）
├─ test/
│  ├─ smoke.mjs             # 路由、故障转移、密钥、用量、伪装
│  ├─ anthropic.mjs         # 协议桥接
│  ├─ ui.mjs                # 最小 DOM 桩：逐页渲染 + 标签配对校验
│  └─ agent-embed.mjs       # 内嵌 Agent 模型通道（runChain 直调、用量记账、故障转移）
├─ scripts/
│  ├─ sync-agent.mjs        # 从 cf-agent-web 同步 agent 源码
│  └─ smoke-combined.mjs    # 合并版本地全栈冒烟
├─ dist/
│  └─ _worker.js            # 打包产物（已随仓库提交，可直接用）
├─ build.mjs                # 零依赖打包器
├─ wrangler.toml            # Workers 轨道配置（Pages 轨道不读它）
├─ package.json
└─ LICENSE (MIT)
```

## 部署方式

同一份源码，两条轨道按需选（可以只部署其中一条，也可以两条同时存在）：

| | Workers 合并版（全功能） | Pages 纯网关版 |
| --- | --- | --- |
| 入口文件 | `src/combined.js`（wrangler.toml 的 main） | `dist/_worker.js`（`node build.mjs` 产物，只含网关） |
| 部署方式 | `npx wrangler deploy` 或 GitHub 连接（Workers Builds） | dashboard 拖拽上传（原有流程，一步没变） |
| 功能 | 网关全部功能 **+ 内嵌 Agent** | 纯网关（无 Agent —— Pages 平台不支持 Durable Objects） |
| 资源绑定 | KV + D1 + R2 + Durable Objects | 仅 KV |
| 环境变量/密码 | dashboard「变量和机密」里配 | dashboard「环境变量」里配（和以前一样） |

**要点**：

- 密码与变量一律在 **dashboard 项目设置**里改（`admin_password` 用 Secret 类型），`wrangler.toml` 的 `[vars]` 段刻意保持注释——配置文件里的 vars 会在每次部署时覆盖 dashboard 的值
- wrangler.toml 里的 KV/D1 **资源 ID 只是标识符不是凭证**，可以提交进 GitHub； Workers 的 KV 若复用 Pages 绑定的同一个命名空间，提供商/模型链/密钥配置自动继承
- Workers 合并版首次部署前需要 `wrangler d1 migrations apply DB --remote` 建 agent 的表，且把 wrangler.toml 里的占位 ID 换成真实值
- 域名如果在 Pages 上，想给 Worker 用需先解绑再绑到 Worker（有秒级切换窗口）；不着急可以先两条轨道并存、用不同子域名
- **dashboard 绑定页 vs wrangler.toml 的优先级**：走 GitHub 连接部署且仓库带 wrangler.toml 时，每次部署以配置文件为准——D1/R2/KV/DO 只在 dashboard 绑定页里加、不写进配置文件的话，下次部署会被冲掉；而「变量和机密」（admin_password 等 Secret）不受影响，在 dashboard 加是安全的。Worker 名字也以配置文件的 `name` 为准，连接仓库前建议删掉随机名的临时 Worker，改走"连接 Git 存储库"的创建流程

### 部署时需填写的变量与资源名称（速查）

**Workers 合并版 —— 写进 `wrangler.toml` 的资源绑定**（ID 只是标识符不是凭证，可提交；`binding` 是代码识别名，固定不可改）：

| 名称（填什么） | 值（怎么填） | 去哪拿 |
| --- | --- | --- |
| `binding = "KV"` | 固定写 `KV` | — |
| `id = ...`（KV） | 你的 KV 命名空间 ID；**复用 Pages 绑定的同一个**则配置自动继承 | dashboard → 存储 → KV → 命名空间详情 |
| `binding = "DB"` | 固定写 `DB` | — |
| `database_name = "agent-web"` | 创建 D1 时自己起的名字 | `wrangler d1 create agent-web` 或 dashboard → D1 |
| `database_id = ...`（D1） | 创建后输出的 UUID | dashboard → D1 → 数据库详情，或 create 命令输出 |
| `binding = "WORKSPACE"` | 固定写 `WORKSPACE` | — |
| `bucket_name = "agent-workspace"` | 创建 R2 桶时自己起的名字 | `wrangler r2 bucket create agent-workspace` 或 dashboard → R2 |
| `SESSIONS` / `AgentSession` / `migrations` | 固定，照抄 wrangler.toml | 无需修改 |

**Workers 合并版 —— dashboard「设置 → 变量和机密」**（随时可改，保存即生效）：

| 变量名 | 值 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `admin_password` | 你的管理密码 | Secret | ✅ | `/admin` 与 `/agent` 登录共用 |
| `url` | `www.bing.com` 或 `off` | 文本 | ❌ | 首页伪装；不设默认伪装 bing |
| `SESSION_SALT` | 随机字符串 | Secret | ❌ | 会话签名加盐，建议设 |
| `SILENCE_ERRORS` | `1` | 文本 | ❌ | 关闭错误信息外泄 |

**Pages 纯网关版 —— dashboard 项目设置**（和合并版同名变量含义一致）：

| 位置 | 名称 | 值 | 类型 |
| --- | --- | --- | --- |
| 设置 → 环境变量 | `admin_password` | 你的密码 | Secret（加密） |
| 设置 → 环境变量 | `url` | `www.bing.com` / `off` | 文本 |
| 设置 → 函数 → KV 命名空间绑定 | `KV` | 选你的命名空间 | 绑定 |

> Agent 的搜索端点/Key（`webSearchUrl` / `webSearchKey`）不是部署变量——部署后在 `/agent` 的「设置」页里运行时配置，存 D1，改完即生效。

### Cloudflare Pages（有且仅有pages本地部署方式，后面不考虑走github部署方案）

> 这是**纯网关**轨道：`node build.mjs` 产出的 `dist/_worker.js` 只含网关文件，
> 不包含内嵌 Agent（Pages 平台不支持 Durable Objects，agent 用起来会有点难以言说的难用）
> 想要带 Agent 的全功能版，用下面的 Workers 轨道；两条轨道可以同时存在。

1. 去 `Releases` 里下载文件 [`"_worker.zip"`](https://github.com/diyu3413/cf-llm-gateway/releases/download/CF-LLM-Gateway-v0.5/_worker.zip) 文件到本地，打开 Cloudflare Dashboard → Workers & Pages → Create → Pages → 拖放文件 里，将此文件通过本地上传到Pages
2. Pages 项目 → Settings → Functions → **KV 命名空间**：
   - 变量名称: `KV`，选择你创建的 KV 命名空间
3. Pages 项目 → Settings → Environment variables：
   - 添加 `admin_password`（Production 和 Preview 都建议设置）
   - 可选添加 `url`
4. 回到 Deployments 点一次 **Retry deployment**，让新变量生效。
5. 部署完成后地址形如 `https://你的项目.pages.dev`，同样支持绑定自定义域名。

### Cloudflare Workers（合并版：网关 + 内嵌 Agent，支持 GitHub 连接部署）

> 这是**全功能**轨道：一个 Worker 同时提供网关和 `/agent` 的文件工作区 Agent
> （会话历史、WebSocket 流式、定时任务全都有）。Agent 的模型调用直连网关调用链，
> 「模型链」页配了什么 Agent 就能用什么，无需再配地址和密钥；
> 用量以「内置 Agent」的虚拟密钥记在「用量」页。
> 管理台左侧 rail 会出现「Agent」入口（只有这个轨道有）。

1. 创建资源（dashboard 网页或 wrangler 命令都行，ID/名称填进 `wrangler.toml`——资源 ID 只是标识符不是凭证，可以提交）：
   - KV：**建议直接复用 Pages 轨道绑定的同一个命名空间**，提供商/模型/密钥配置自动继承
   - `wrangler d1 create agent-web` → `database_name` / `database_id` 填入
   - `wrangler r2 bucket create agent-workspace`
2. `npx wrangler d1 migrations apply DB --remote`（建 agent 的表）
3. 部署：`npx wrangler deploy`；或在 GitHub 仓库设置里连接 **Workers Builds**（构建配置用仓库自带的 `wrangler.toml`，push 即自动部署）。注意 `main` 指向 `src/combined.js`（合并版入口），纯网关场景想用 Workers 跑也可以改回 `src/index.js`
4. 密码和变量（二选一或混用）：`wrangler secret put admin_password`，或在 Worker 的 设置 → 变量和机密 里添加（`admin_password` 用 Secret 类型；`url`、`SESSION_SALT` 可选）。`wrangler.toml` 的 `[vars]` 段刻意保持注释——配置文件里的 vars 会在每次部署时覆盖 dashboard 的值
5. 部署后：`https://你的域名/admin` 是网关控制台（左侧 rail 多出「Agent」项），`https://你的域名/agent` 是 Agent 页（首次进入用同一密码再登一次，两边会话 Cookie 各自独立）
6. 想自己开发部署 agent，参考同级目录的 [cf-agent-web](https://github.com/diyu3413/cf-agent-web)（独立版）；本仓库的 `src/agent/` 是它的内嵌拷贝，用 `npm run sync-agent` 同步

#### Fork 我的仓库，用自己的 D1/R2 部署（推荐给想自用的其他用户）

不需要在本地装任何工具，全程浏览器 + Cloudflare 网页即可。填哪些值拿不准就对照上面的「速查」表。

1. **Fork 仓库**：本仓库右上角 **Fork → Create fork**，把代码复制到你的账号下
2. **创建三个资源**（Cloudflare dashboard 网页上点出来，名字随意但建议照抄）：
   - KV：**存储和数据库 → KV → 创建命名空间**（如 `agent-kv`），创建完点进详情页**复制命名空间 ID**
   - D1：**存储和数据库 → D1 → 创建数据库**（名 `agent-web`），详情页**复制数据库 ID**（一串 UUID）
   - R2：**对象存储 R2 → 创建存储桶**（名 `agent-workspace`；首次使用会提示激活，按提示开通即可，免费额度内不扣费）
3. **改你 fork 里的 `wrangler.toml`**（直接在 GitHub 网页上改，不用 clone）：打开你 fork 的仓库 → 点开 `wrangler.toml` → 右上角铅笔图标编辑 → 替换三处：
   - `id = "..."`（KV）→ 你的命名空间 ID
   - `database_id = "..."` → 你的 D1 UUID（`database_name` 与你起的名字保持一致）
   - `bucket_name = "..."` → 你的桶名
   - 拉到底部 **Commit changes** 提交
4. **建 agent 的表**（不做这步 agent 会话不可用，网关本身不受影响）：
   - 有本地 Node：`git clone` 你的 fork 后执行 `npx wrangler d1 migrations apply DB --remote`（会要求 `wrangler login` 授权）
   - 纯网页替代方案：dashboard → 存储和数据库 → D1 → 点你的数据库 → **控制台**，把仓库里 `migrations/0001_init.sql` 和 `0002_settings.sql` 的内容先后粘贴进去执行
5. **连接部署**：Workers 和 Pages → **创建 → 选择 Git 存储库**（没有就先授权绑定 GitHub）→ 选中你 fork 的仓库 → 构建配置保持默认（用仓库自带的 `wrangler.toml`）→ 部署。Worker 名会取自配置里的 `cf-llm-gateway`
6. **设密码**：部署完成的 Worker → 设置 → 变量和机密 → 添加 `admin_password`（打开右侧**密钥开关**）
7. **核对绑定**：设置 → 绑定 页应能看到 `KV` / `DB` / `WORKSPACE` / `SESSIONS` 四个绑定——它们由 wrangler.toml 自动应用，**这个页面只用来核对，不要手动增删**（下次部署会以配置文件为准）
8. **后续更新**：你的 fork 页面有 **Sync fork** 按钮，点它拉取我的更新；若 `wrangler.toml` 有变动会提示冲突，保留你填的那三处 ID 即可

两点说明：fork 是公开的，`wrangler.toml` 里的资源 ID 也会公开——它们只是标识符不是凭证，泄露不了什么；真正要保密的 `admin_password` 和上游 API Key 分别走 Secret 和网关控制台，都不进仓库。

## 内嵌 Agent（demo）

> **这是个人自用的 demo**：单管理员设计、无多租户、不做配额计费，功能以"够自己用"为标准，随时可能调整。只要觉得有用就拿去玩，但别按生产级服务的预期来要求它。

仅 **Workers 合并版**可用（Pages 纯网关版没有这个功能）。部署后在管理台左侧 rail 最底部会出现「Agent」入口，或直接访问 `/agent`（首次进入用同一个 `admin_password` 再登一次，两边会话 Cookie 各自独立）。

**它是什么**：一个跑在网页里的文件工作区 agent——R2 是它的文件系统，D1 只存索引，每个会话一个 Durable Object（消息历史、WebSocket 流式、定时任务都在里面），模型调用**直连网关调用链**：「模型链」页配了什么它就能用什么，无需再配地址和密钥，故障转移照常生效；用量以「内置 Agent」的虚拟密钥记在「用量」页。

| 能力 | 说明 |
| --- | --- |
| 工作区文件 | `workspace_list / read / write / edit / delete`：读写 R2 里的文本文件，edit 为精确替换（要求唯一命中），用 R2 `onlyIf` 条件写防并发覆盖 |
| 全文检索 | `workspace_search`：D1 FTS5，中文按单字 + 二字组索引，2 字以上中文词可搜 |
| 定时任务 | `schedule_task`：DO alarm 到点把 agent 唤醒继续干活（"一小时后提醒我检查 xx"） |
| 联网（可选） | 设置页配 Tavily 兼容搜索端点后获得 `web_search`；`web_fetch` 由 Worker 原生抓网页转纯文本，独立于搜索开关 |
| 界面 | WebSocket 流式输出 + 打字机；推理模型的**思考过程**可折叠回看（随会话持久化）；工具卡片带耗时；会话累计 token / 缓存命中；assistant 回复按 **markdown** 渲染（先转义再渲染，防注入）；移动端会话抽屉；文件可下载回本地 |

**省免费额度的设计**：文件正文只在 R2；聊天记录存 DO 自带 SQLite（不占 D1 行数）；D1 只存设置/会话列表/索引；agent 的模型调用走进程内 `runChain` 不占子请求额度。

**边界（有意不做）**：不执行代码/命令（没有沙箱）；二进制文件不入索引不可编辑（只能删）；JS 渲染的 SPA 页面 `web_fetch` 抓不到正文；表格 markdown 暂不渲染；上下文超预算丢最旧对话段；聊天记录随 DO 存储有免费容量上限（5GB 级，个人用不完）。独立版 agent 见 [cf-agent-web](https://github.com/diyu3413/cf-agent-web)，本仓库 `src/agent/` 是它的内嵌拷贝（`npm run sync-agent` 同步）。

## 使用步骤

1. 打开 `https://你的域名/admin`，用 `admin_password` 登录。
2. 进「提供商」页点击"添加提供商"，选择预设模板（DeepSeek / NVIDIA / Gemini / 通义千问 / MiMo 等，切换模板时显示名称和 Base URL 会自动跟随）或选"自定义"，填入 Base URL 和该服务商的 API Key，保存。
   - 保存后可以点"测试"确认这把 key 通不通，再往下走。
3. 点击该服务商卡片上的"搜索模型"，会调用其 `GET /models` 接口拉取真实可用模型列表并导入（比如同时出现 `deepseek-chat`、`deepseek-reasoner` 等），支持关键字筛选和全选，勾选后加入调用链。
4. 进「模型链」页：
   - 用上下箭头调整调用优先级，序号 1 最优先；
   - 点"设为默认"指定默认调用模型；
   - 点"编辑"可以改对外别名、手动打开/关闭 视觉 / 音频 / 视频 / 工具调用 / 推理 标签，以及填写"转发时删掉的参数"（某些上游会因为不认识的参数直接 400）。
5. 进「密钥」页点击"创建密钥"：
   - 弹窗里**必须填写备注**才能继续（留空点"下一步"会提示"请输入密钥备注"）
   - 创建后完整显示生成的密钥（仅这一次），点"复制密钥"按钮即可复制到剪贴板
   - 备注会显示在密钥列表和用量页里，用来区分是哪个客户端在调
6. 把下面两组信息填到 Claude Code / AstrBot 等项目的"自定义 OpenAI / Anthropic 服务"配置里（两种格式的具体 Base URL 也能在「概览」页直接复制）：
   - OpenAI 兼容：Base URL `https://你的域名/v1`，`Authorization: Bearer <key>`
   - Anthropic 兼容（Claude Code 等）：`ANTHROPIC_BASE_URL=https://你的域名`，`ANTHROPIC_AUTH_TOKEN=<key>`
   - 模型：可以留空/填 `auto`（自动按顺序故障转移），也可以先请求 `GET /v1/models` 拿到具体模型 id 直接指定。

## 对外协议格式

| 协议           | 接口路径                                                     | Base URL 填法                                                | 鉴权方式                      | 典型客户端                              |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------- | --------------------------------------- |
| OpenAI 兼容    | `POST /v1/chat/completions`、`GET /v1/models`、`POST /v1/embeddings`、`POST /v1/completions` | `https://你的域名/v1`                                        | `Authorization: Bearer <key>` | AstrBot、大多数第三方 OpenAI 客户端     |
| Anthropic 兼容 | `POST /v1/messages`、`POST /v1/messages/count_tokens`        | `https://你的域名`（不带 `/v1`，客户端会自动拼 `/v1/messages`） | `x-api-key: <key>`            | Claude Code 等原生 Anthropic 协议客户端 |

网关本身对这两种鉴权头都兼容，用哪个都能通过。`/v1/messages` 内部会把 Anthropic 请求体（含 `system`、多模态 `content` 数组、`tools`/`tool_choice`、流式 `stream: true`）转换为 OpenAI chat-completions 格式，调用同一条按顺序故障转移的模型链路，再把响应（含 SSE 流式事件）转换回 Anthropic 的 `message_start` / `content_block_delta` / `message_stop` 等事件格式返回。

Claude Code 接入示例：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_AUTH_TOKEN="sk-gw-…（在 /admin 生成的密钥）"
claude
```

> `ANTHROPIC_BASE_URL` 只填到域名，后面的 `/v1/messages` 是 SDK 自己拼的，写上去会变成 `/v1/messages/v1/messages`。

AstrBot 接入时如果下拉框里选不到模型，九成是 Base URL 少写了 `/v1` —— 它是拿 `{base_url}/models` 去拉列表的，少一截就 404，界面上只会显示空列表，不会告诉你为什么。

其余客户端（Cherry Studio、NextChat、LobeChat、OneAPI 等）凡是能填"OpenAI 兼容接口"的，Base URL 填 `https://你的域名/v1`、API Key 填网关密钥即可。

## 调用行为说明

- 请求 `model` 字段为空、`auto`，或者不匹配任何已导入模型时：从默认模型开始，按「模型链」页设定的顺序依次尝试；第一个成功（HTTP 2xx 且流内无错误）的立即返回结果并**停止后续尝试**；全部失败则返回 `403`，响应体的 `error.details` 里附上每一次尝试的状态码和错误信息。
- 请求 `model` 字段是一个已知的具体模型别名（可从 `GET /v1/models` 获取）：该模型排到队首优先调用，失败后**默认仍会继续沿链路往下降级**。想要"点名了就只调这一个、失败直接报错"，在「设置」页打开**严格模型路由**。
- 调用失败的模型会进入冷却表（默认 180 秒，设置页可调，填 0 关闭），冷却期内直接跳过、连请求都不发。冷却只存在内存里，实例回收即清空，「概览」页可以手动解除。
- 响应头里会带上本次实际用了哪个模型，排查时看这个最快：

```
X-Gateway-Model: deepseek-chat
X-Gateway-Upstream-Model: deepseek-chat
X-Gateway-Provider: DeepSeek
X-Gateway-Attempts: 2
```

`X-Gateway-Attempts: 2` 就是说第一个挂了、第二个接住了。

- 这里没有做**"先探活再调用"**：那样每个模型要花两个子请求，还不准（探活通了不代表这次请求能通）。直接发真实请求本身就是最准确的连通性判定。
- 有些上游会返回 HTTP 200、但把错误塞在 SSE 的第一个事件里。流式请求会先读一块看一眼，是错误就转到下一个模型，不是就原样接回流里继续，不丢数据也不加延迟。首块迟迟不来（推理模型首 token 慢是常事）就直接放行，不瞎判（该行为可在「设置」页关闭）
- 还有一种更阴的：**流到一半**才吐 `{"error":...}` 然后断流。首块探查管不到它，网关会在流尾补发一个合成错误事件（`type: "gateway_mid_stream_error"`），内容原样透传不改——标准 OpenAI SDK 会忽略它，而 agent 这类自动重试方能据此判定这轮作废、整轮重试。Anthropic 桥接流同理，中途出错会用协议规定的 `event: error` 终止，而不是装作正常收尾。

## 用量统计

「用量」页按对外 API Key 列出调用次数和 token 消耗：总调用次数、输入 / 输出 / 合计 tokens、最近使用时间，点"明细"能看到按模型、按接口（`chat` / `messages` / `embeddings` / `count_tokens` / `models`）的细分。

token 数分两种来源：

- 上游在响应里返回了 `usage` 字段（DeepSeek 和多数国产厂商的非流式接口都会给）→ 直接采信真实值。
- 上游没返回（OpenAI 流式默认不带 `usage`）→ 按回复正文的字数估算，CJK 按 1.5 字/token、其余按 4 字符/token，与 `/v1/messages/count_tokens` 是同一套算法。这类记录会计进"估算条数"单独显示。

**别拿它对账。** 它统计的是网关这一侧看到的量，跟各家服务商的账单对不上，估算的那部分更是只能看个量级。

至于为什么不会把 KV 写额度耗光：计数先在内存里累加，默认 300 秒才批量落一次盘，最坏一天不到 300 次写。面板读的是「KV 里的基线 + 内存里还没落盘的增量」，所以显示的数字是实时的，不用等落盘。间隔在「设置」页可调，最小 30 秒；嫌它多余可以整个关掉，转发路径上连那一遍响应体扫描都省了。"重置统计"会把 KV 里的记录一并删掉。

## 伪装域名

为了使得页面整洁那么一些，项目添加了”伪装域名“的选项：

不设 `url` 变量时，访问 `https://你的域名/` 显示的是 bing 的首页；设了就显示你指定的那个站点。管理面板和 API 接口都不受影响。

| `url` 的值             | 效果                                      |
| ---------------------- | ----------------------------------------- |
| 不设置                 | 伪装成 `www.bing.com`（默认）             |
| `example.com`          | 伪装成该站点，不带协议时自动补 `https://` |
| `https://example.com/` | 同上                                      |
| `off`                  | 关闭伪装，显示网关自带的落地页            |

实现上只代理根路径这一个页面，不是通用反向代理 —— Cloudflare 的服务条款不允许把 Workers 当开放代理用。回源来的 HTML 会被注入一条 `<base href="目标站点/">`，页面里的图片和 CSS 由浏览器直接去目标站点取、不经过你的 Worker，所以伪装一次只花 1 个请求；回源结果还会走边缘缓存（30 分钟），重复访问基本连 Worker 都不用醒。目标站点的 `Set-Cookie` 一律不透传，免得别人的 cookie 被写到你的域名下。

开启伪装后，未知路径会返回一个中性的 404，不会像默认那样在报错里写明"控制台在 /admin"；`/v1/*` 仍然返回可读的错误信息，方便排查客户端问题。

> ⚠️ 伪装只是让首页看起来平平无奇，**不是访问控制**，`/admin` 该在还在 —— 真正挡人的是管理员密码和网关密钥。另外目标站点如果是重度 SPA，注入 `<base>` 之后可能渲染不全，挑个静态点的站更稳。

## 优选IP

本义是探查 **对于你目前所在ip为基准，探测与cloudflare最近的边缘节点ip的延迟** ，这里的延迟一定程度上代表着“客户端从发送调用到回复的间隔”，决定了回复速度。

先把原理说清楚：**走哪个边缘节点是 anycast 路由决定的，Worker 自己改不了**，任何声称能在服务端"优选节点"的做法都不成立。能优化的只有你本机到 Cloudflare 这一段，办法是把域名解析指到延迟更低的 CF IP。而网关到 NVIDIA / OpenAI 那一段本来就跑在 Cloudflare 骨干网上，不需要也没法优选 —— 这一段恰恰是本项目对大陆用户最值钱的地方。

所以「优选IP」页只做了能做的部分：

- 显示当前接入的机房代号、你的出口 IP、往返延迟。探测走 `/cdn-cgi/trace`，这个路径由 Cloudflare 边缘直接响应，**不触发 Worker、不消耗每日请求额度**。
- 连测 10 次给出最快 / 中位 / 最慢，判断有没有优化空间。中位数低于 120ms 基本不用折腾。
- hosts 生成器：本机用 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 测出低延迟 IP 后粘进来，生成可直接用的 hosts 行。

> 警告⚠️：hosts 只对**自定义域名**有效。`*.pages.dev` 和 `*.workers.dev` 因为 SNI 校验的关系改了也白改，想优选就得先绑自己的域名。

## 安全

- 管理员密码只存在环境变量里，登录后签发 HMAC-SHA256 签名的会话 Cookie（HttpOnly + SameSite=Strict，12 小时过期）。签名密钥从密码派生，所以**改了密码，所有已签发的会话立刻失效**。
- 登录失败限速：同一 IP 10 分钟内 8 次，纯内存实现，不占 KV 写额度。
- 对外 API Key 在 KV 里只存 SHA-256，明文只在创建那一刻返回一次，比对用恒定时间算法。
- 单密钥限速：「设置」页可设每分钟请求数上限（默认 0 = 不限），内存滑动窗口实现，isolate 重启即清零。给 agent 这类自动循环的客户端专门设一把限速 Key，防止失控打爆上游；超限返回 429 并带 `Retry-After`。
- `/admin` 及其接口的响应**不带 CORS 头**（管理台只被同源访问，没必要对任意来源开放响应体）；`/v1/*` 保持放开，浏览器端第三方客户端可以直连。
- 上游 API Key 存在 KV 里（明文，因为要拿去调上游），但**后台接口永远只回传掩码**，抓包也拿不到。
- `/robots.txt` 全站 disallow，后台带 `noindex`。
- 「设置」页可导出完整配置备份，但**导出内容包含上游 API Key 明文**，请当密码文件保管。

> 这边先声明一点：别把鉴权关了。Cloudflare 的服务条款不允许把 Workers 当开放代理，被人扫到白嫖是小事，账号被封是大事，到时账号因为这问题被封了不要来找我。

## 本地开发

```bash
npm install
npm test              # 构建 + 全部断言（网关 132 项 + 内嵌 Agent 通道 12 项，模拟 KV/上游/DOM，不需要网络）
npm run build         # 只生成 dist/_worker.js（Pages 纯网关产物）
npm run dev           # wrangler 本地起合并版（网关 + /agent，本地模拟 KV/D1/R2/DO）
npm run sync-agent    # 从 ../cf-agent-web 同步 agent 源码到 src/agent/（覆盖实现除外）
```

**改完 `src/`（不含 `src/agent/`）记得重新 build 并把 `dist/_worker.js` 一起提交**，CI 会检查这两者是否同步。

`src/agent/` 是 [cf-agent-web](https://github.com/diyu3413/cf-agent-web)（独立版 agent）的内嵌拷贝，**不要直接改**：改那边，然后 `npm run sync-agent` 同步过来。唯一例外是两个覆盖实现——`src/agent/lib/fetchchat.js`（内嵌模型通道，直调 `runChain`）和 `src/agent/lib/features.js`（内嵌特性，模型列表来自「模型链」），它们只存在于本仓库，同步脚本刻意不覆盖，与独立版的同名文件保持同一签名。

合并版本地冒烟（需要先 `node ../cf-agent-web/scripts/mock-gw.mjs` 起假上游）：

```bash
node scripts/smoke-combined.mjs   # 双端登录/内嵌模型链/对话写文件/用量记账/网关转发，21 项
```

`test/ui.mjs` 用一个最小 DOM 桩把管理面板前端真跑一遍，逐个标签页触发渲染并做标签配对校验 —— 这类"某个视图少一个 `</div>` 导致整页塌掉"的问题只在浏览器里才暴露，靠它在提交前挡住。

## Anotherquestions

有些事这个项目做不到或者做不准，保险起见这边先在这说一嘴：

1. **模型的多模态标注是猜的。** 各家的 `/v1/models` 基本只返回一个 id，没有模态信息。搜索时按模型名做启发式判断（含 `vl` / `vision` / `omni` 判为视觉，含 `embed` 判为向量，等等），猜错了在模型编辑里手工改，手工值优先。
2. **预设的 Base URL 会过期。** 厂商随时可能调整地址（比如 MiniMax 已从 `api.minimax.chat` 迁到国内 `api.minimaxi.com` / 国际 `api.minimax.io`，对于这个我没内设自动更新机制，其实不知道怎么设置），预设只是省事用的，面板里所有字段都能手工改。发现某家连不上，先去官方文档核对 Base URL。
3. **token 计数是估算值。** 各家上游没有统一的 token 计数接口，`/v1/messages/count_tokens` 和「用量」页在上游不返回 `usage` 时都按字符数估算。够 Claude Code 用、够你判断量级，但别拿它对账，cf身为中转误差是一定存在的。
4. **Anthropic 桥接不覆盖全部特性。** 文本、图片、system、tools / tool_use / tool_result、流式都通了；extended thinking、citations、文档块、prompt caching 没有 OpenAI 对应物，不支持。
5. **`developer` 角色会被改写成 `system`。** 新版 OpenAI SDK 会把 system 提示发成 `role: "developer"`，除 OpenAI 自己外几乎没有兼容接口认它（MiniMax 直接 400）。默认统一映射，需要原样透传可在「设置」页关闭。
6. **统计和冷却不跨实例。** 用量落盘之前的增量只存在产生它的那个实例里，多实例并发时别的实例还没落盘的部分要等下个周期才出现。总数最终是准的，只是不保证秒级一致。
7. **本地地址连不上。** Ollama、LM Studio 这类跑在你自己机器上的服务，Cloudflare 的边缘节点访问不到，除非你做了内网穿透。

## License

本项目依 MIT 许可证条款授权。
