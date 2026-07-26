# cf-llm-gateway

把多家大模型服务商（NVIDIA NIM / Google Gemini / OpenAI 等）的 API Key 汇聚到 Cloudflare Worker/Pages 项目里，对外统一暴露一个新的、随时可重置的 API Key，同时提供 OpenAI 和 Anthropic 两种标准接口格式，可直接接入 Claude Code、AstrBot 等任何第三方项目；并借助 CF 全球边缘网络，帮你访问在国内被 wall 的模型服务商。

## 目录

- [功能一览](#功能一览)
- [目录结构](#目录结构)
- [部署方式一](#部署方式一)
- [部署方式二](#部署方式二)
- [使用步骤](#使用步骤)
- [对外协议格式](#对外协议格式)
- [调用行为说明](#调用行为说明)
- [用量统计](#用量统计)
- [伪装域名](#伪装域名)
- [优选IP](#优选IP)
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

## 目录结构

```
cf-llm-gateway/
├─ src/
│  ├─ index.js              # Worker 入口 / 路由
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
│  └─ ui/
│     ├─ css.js             # Material Design 3 样式（含移动端抽屉、动效）
│     ├─ app.js             # 管理面板前端，构建时整个内联进 HTML
│     └─ html.js            # 页面骨架
├─ test/
│  ├─ smoke.mjs             # 路由、故障转移、密钥、用量、伪装
│  ├─ anthropic.mjs         # 协议桥接
│  └─ ui.mjs                # 最小 DOM 桩：逐页渲染 + 标签配对校验
├─ dist/
│  └─ _worker.js            # 打包产物（已随仓库提交，可直接用）
├─ build.mjs                # 零依赖打包器
├─ wrangler.toml
├─ package.json
└─ LICENSE (MIT)
```

## 部署方式一：Cloudflare Workers（git 直接导入）

1. Fork / push 本项目到你自己的 GitHub 仓库。
2. Cloudflare Dashboard → Workers & Pages → Create → Workers → **Import a repository**，选择该仓库。
3. 创建 KV 命名空间：Workers & Pages → KV → Create namespace，随便起名（例如 **`llm-gateway-kv`**）。
4. 回到该 Worker → Settings → Bindings → 添加 **KV 命名空间**：
   - 变量名称: `KV`（必须完全一致）
   - 选择刚创建的命名空间
5. 设置 → 变量和密钥 → 添加变量：
   - Name: `admin_password`，Type 选 **Text**（或用 Secret 更安全），值为你自定义的管理密码
   - 可选：Name: `url`，Type 选 **Text**，值为要伪装的站点（见下方「首页伪装」）
6. **改完变量必须重新部署一次**，否则新变量不会对已部署的版本生效。
7. 部署完成后访问：
   - API: `https://你的worker子域.workers.dev/v1/chat/completions`
   - 管理面板: `https://你的worker子域.workers.dev/admin`
8. 如需自定义域名，在 Worker → Triggers → 自定义域 里添加即可，API 地址随之变为
   `https://你的域名/v1/chat/completions`。

也可以本地用 wrangler 直接发布：

```bash
npm install
npx wrangler kv namespace create KV   # 记下返回的 id，填入 wrangler.toml
npx wrangler secret put admin_password
npx wrangler deploy
```

> 没绑 KV 的话后台照样能打开，但改的配置一个都存不住，重新部署就全没了。面板顶部会挂红字提醒，最好别忽略它（除非是拿来当展示域名来展示webui功能）

## 部署方式二：Cloudflare Pages（`_worker.js` 单文件，推荐）

Pages 的 git 集成不会执行 `wrangler.toml` 里的绑定，需要在 Pages 项目设置里手动添加 KV 绑定和变量。

1. 本地打包（`dist/_worker.js` 已随仓库提交，跳过这步直接用也行）：

```bash
npm install
npm run build   # 生成 dist/_worker.js
```

2. 把仓库 push 到 GitHub，Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接该仓库。
   构建命令填 `npm run build`，输出目录填 `dist`（`_worker.js` 位于该目录根部，会被 Pages 自动识别为 Functions 入口）。
3. Pages 项目 → Settings → Functions → **KV 命名空间**：
   - 变量名称: `KV`，选择你创建的 KV 命名空间
4. Pages 项目 → Settings → Environment variables：
   - 添加 `admin_password`（Production 和 Preview 都建议设置）
   - 可选添加 `url`
5. 回到 Deployments 点一次 **Retry deployment**，让新变量生效。
6. 部署完成后地址形如 `https://你的项目.pages.dev`，同样支持绑定自定义域名。

（也可以选择去 `Releases` 下载 `_worker.zip` 文件，使用本地上传的方式来进行部署，推荐本地上传方法）

> 说明：`_worker.js` 是 `build.mjs` 把 `src/` 下所有 ES module 拼成的单文件产物，逻辑与 Workers 版完全一致，因此两种部署方式功能完全对等，任选其一即可。没用 esbuild / rollup —— 模块之间只有单向依赖、顶层标识符互不重名，顺序拼接再去掉 `import`/`export` 就够了，构建 0.1 秒，Pages 的 git 构建也不用装依赖。

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

> 面板在手机上也能用：屏幕窄于 840px 时左侧功能栏会收进抽屉，点左上角的三条横杠展开；夜间模式切换在抽屉底部。

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

## 优选 IP

这里的本义是探查**“对于你目前所在ip为基准，探测与cloudflare最近的边缘节点ip的延迟”**，这里的延迟一定程度上代表着“客户端从发送调用到回复的间隔”，决定了回复速度。

先把原理说清楚：**走哪个边缘节点是 anycast 路由决定的，Worker 自己改不了**，任何声称能在服务端"优选节点"的做法都不成立。能优化的只有你本机到 Cloudflare 这一段，办法是把域名解析指到延迟更低的 CF IP。而网关到 NVIDIA / OpenAI 那一段本来就跑在 Cloudflare 骨干网上，不需要也没法优选 —— 这一段恰恰是本项目对大陆用户最值钱的地方。

所以「优选 IP」页只做了能做的部分：

- 显示当前接入的机房代号、你的出口 IP、往返延迟。探测走 `/cdn-cgi/trace`，这个路径由 Cloudflare 边缘直接响应，**不触发 Worker、不消耗每日请求额度**。
- 连测 10 次给出最快 / 中位 / 最慢，判断有没有优化空间。中位数低于 120ms 基本不用折腾。
- hosts 生成器：本机用 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 测出低延迟 IP 后粘进来，生成可直接用的 hosts 行。

> 警告⚠️：hosts 只对**自定义域名**有效。`*.pages.dev` 和 `*.workers.dev` 因为 SNI 校验的关系改了也白改，想优选就得先绑自己的域名。

## 安全

- 管理员密码只存在环境变量里，登录后签发 HMAC-SHA256 签名的会话 Cookie（HttpOnly + SameSite=Strict，12 小时过期）。签名密钥从密码派生，所以**改了密码，所有已签发的会话立刻失效**。
- 登录失败限速：同一 IP 10 分钟内 8 次，纯内存实现，不占 KV 写额度。
- 对外 API Key 在 KV 里只存 SHA-256，明文只在创建那一刻返回一次，比对用恒定时间算法。
- 上游 API Key 存在 KV 里（明文，因为要拿去调上游），但**后台接口永远只回传掩码**，抓包也拿不到。
- `/robots.txt` 全站 disallow，后台带 `noindex`。
- 「设置」页可导出完整配置备份，但**导出内容包含上游 API Key 明文**，请当密码文件保管。

> 这边先声明一点：别把鉴权关了。Cloudflare 的服务条款不允许把 Workers 当开放代理，被人扫到白嫖是小事，账号被封是大事，到时账号因为这问题被封了不要来找我。

## 本地开发

```bash
npm install
npm test          # 构建 + 跑 132 项端到端断言（模拟 KV、上游和 DOM，不需要网络）
npm run build     # 只生成 dist/_worker.js
npm run dev       # wrangler 本地起服务
```

**改完 `src/` 记得重新 build 并把 `dist/_worker.js` 一起提交**，CI 会检查这两者是否同步。

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
