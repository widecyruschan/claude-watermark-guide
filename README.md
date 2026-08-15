# Claude Watermark Guide — Static Site

Claude 隐形文本水印资讯 / 工具站（ShipSolo 流水线 01–09 产物）。
纯静态 + 纯客户端 JS 工具，Cloudflare Pages 兼容。

## 结构
- `index.html`                首頁（hero + 工具卡 + 導航卡）
- `pages/checker.html`        免費自測工具（純客戶端，文本不上傳）
- `pages/what-is-*.html`       解釋型文章（FAQPage 結構）
- `pages/how-it-works.html`    技術原理（公開部分，標 [待确认]）
- `pages/changes-2026.html`    近期變化時間線（標 [待确认] + 時效提示）
- `pages/privacy|terms|cookie` 法律頁（合規草稿）
- `css/style.css`             設計系統 token（IBM Plex / 單藍 accent / 4px 圓角）
- `js/checker.js`             客戶端啟發式（無 API、無上傳）
- `docs/prd/backend-membership-prd.md` 後台、會員、訂閱與管理功能 PRD
- `sitemap.xml` / `robots.txt` SEO 索引

## 待回填（標 [待确认] 項）
- `[DOMAIN]` → 真實域名（7 處：canonical + sitemap + robots）
- 文章頁真實來源引用（Help Center / Forbes / Reddit）
- 真實 GA4 / Clarity ID（目前 cookie banner 存在但未埋真實 SDK）
- /checker 是否 index（sitemap 默認 index，待確認）

## 部署到 Cloudflare Pages
1. 把本目錄推到 GitHub repo
2. Cloudflare Dashboard → Pages → 連接 repo → Build: 無（純靜態）
3. 或 CLI：`npx wrangler pages deploy . --project-name claude-watermark-guide`
4. 綁定自訂域 + 替換 `[DOMAIN]`

## 本地預覽
```bash
npx serve .        # 或 python3 -m http.server 8000
```

## 合規紅線（PRD NOT-DO / 禁詞）
- 不聲稱官方合作 / 100% 準確 / 永久免費 / 無限
- 工具頁已寫「啟發式、非官方、不保證準確」

## 会话总结记录

### 2026-08-15：AI 文本润色、后台与会员方案评估
- 会话主要目的：根据新增功能截图，评估隐藏 Unicode 字符清理、AI 文本润色、后台管理与会员订阅的实现方案。
- 完成的主要任务：检查现有静态站结构；区分浏览器本地清理与服务端 AI 改写；调研当前模型、Cloudflare、Supabase 与 Stripe 的官方能力。
- 关键决策和解决方案：保留当前静态前端；本地完成字符检测、清理、破折号选项和差异统计；AI 润色通过 Cloudflare Worker 与 AI Gateway 调用；会员数据使用 Supabase Auth/Postgres/RLS；订阅使用 Stripe Checkout、Customer Portal 和 Webhook。
- 使用的技术栈：原生 HTML/CSS/JavaScript、Cloudflare Pages/Workers/AI Gateway、Supabase、Stripe，以及可替换的大语言模型供应商。
- 新增或修改文件：仅追加本 README 会话记录，未修改页面或业务代码。
- 后续建议：先确认首发市场、产品定位与合规文案，再按“本地清理、AI 润色、会员订阅、管理后台”顺序分阶段实现，并用真实文本评测集选择默认模型。

### 2026-08-15：确定 EBond AI 模型供应商
- 会话主要目的：将 AI 文本润色模型确定为 EBond API 提供的 `gpt-5.5`。
- 完成的主要任务：读取 EBond API 公开页面；确认 OpenAI 兼容的 `/v1` 接口与 Bearer API Key 鉴权要求；根据指定单价更新成本方案。
- 关键决策和解决方案：服务端由 Cloudflare Worker 直接调用 `https://api.ebondai.com/v1`，浏览器不得接触供应商密钥；模型固定为 `gpt-5.5`，单价按每百万输入/输出 Token `US$0.6/US$3.6` 计算。
- 使用的技术栈：Cloudflare Workers、EBond API、`gpt-5.5`、服务端流式转发与用量记账。
- 新增或修改文件：仅追加本 README 会话记录，未修改页面或业务代码，未创建或提交任何 `.env` 文件或密钥。
- 后续建议：获得密钥后先在本地 Secret 中验证模型 ID、流式响应和 usage 字段，再实现配额预占、失败回滚、超时与成本记录。

### 2026-08-15：确认 EBond API 协议参数
- 会话主要目的：根据 EBond 核心参数截图，统一网关地址与具体 API 端点。
- 完成的主要任务：确认网关根地址、`sk-` 密钥格式、Responses API 模式及 Chat Completions 兼容地址。
- 关键决策和解决方案：配置 `EBOND_BASE_URL=https://api.ebondai.com`；首选请求端点按 OpenAI 兼容规则使用 `/v1/responses`；保留 `/v1/chat/completions` 作为兼容回退；所有请求只从 Cloudflare Worker 发起。
- 使用的技术栈：EBond API、OpenAI Responses API、Chat Completions API、Cloudflare Worker Secret。
- 新增或修改文件：仅追加本 README 会话记录，未写入真实 API Key。
- 后续建议：使用真实密钥验证 `/v1/responses` 的请求字段、SSE 事件、结束原因与 usage 数据；验证通过前不将该推导视为已完成联调。

### 2026-08-15：说明 Cloudflare Secret 配置
- 会话主要目的：说明 EBond API Key 在 Cloudflare 生产环境和本地开发环境中的安全配置方式。
- 完成的主要任务：核对 Cloudflare Workers 与 Pages Functions 的官方 Secret 配置流程，并确认当前项目仍是纯静态部署。
- 关键决策和解决方案：生产密钥绑定到实际执行 AI 请求的 API Worker；使用 `wrangler secret put EBOND_API_KEY` 或控制台的 Variables and Secrets 创建加密 Secret；静态前端不得访问该值。
- 使用的技术栈：Cloudflare Workers、Wrangler、Worker Secret、`.dev.vars` 本地变量。
- 新增或修改文件：仅追加本 README 会话记录，未创建本地变量文件，未写入或提交任何密钥。
- 后续建议：API Worker 建立后再配置生产 Secret；本地开发前将 `.dev.vars*` 加入 `.gitignore`。

### 2026-08-15：完成 Cloudflare CLI 配置
- 会话主要目的：登录 Wrangler，定位已配置 Secret 的 Cloudflare 项目，并建立本地命令行配置。
- 完成的主要任务：完成 Cloudflare OAuth 登录；确认目标是 Pages 项目 `claude-watermark-guide`；验证 production 环境存在加密的 `EBOND_API_KEY`；从远端下载 `wrangler.toml`。
- 关键决策和解决方案：沿用现有 Pages 项目而不创建错误的同名 Worker；公开变量保存在 Wrangler 配置，密钥只保留在 Cloudflare production Secret；本地变量文件全部忽略。
- 使用的技术栈：Wrangler 4、Cloudflare Pages、Pages Secret、TOML。
- 新增或修改文件：新增 `wrangler.toml`，配置 Pages 项目名、`dist` 输出目录与公开模型变量；更新 `.gitignore` 与本 README；未下载、显示或写入真实 API Key。
- 后续建议：新增 Pages Function 后通过 `context.env.EBOND_API_KEY` 调用 EBond API，并分别验证本地与 production 环境。

### 2026-08-15：完成后台与会员系统 PRD
- 会话主要目的：为 API 接入后的后台、会员、订阅、配额与管理功能提供可执行的产品需求和详细开发步骤。
- 完成的主要任务：编写完整 PRD；定义 40 条用户故事、数据模型、API 合同、权限、计费、管理后台、测试边界、验收标准与 9 个开发阶段；发布 GitHub Issue #1。
- 关键决策和解决方案：MVP 使用同项目 Pages Functions、Supabase Auth/Postgres/RLS、Stripe Checkout/Portal/Webhook 与 EBond `gpt-5.5`；本地字符工具免费且不上传，AI 润色登录后按输入字符计额，原文默认不落库。
- 使用的技术栈：Cloudflare Pages Functions、TypeScript、Hono、Zod、Supabase、Stripe、EBond API、Vitest、Playwright。
- 新增或修改文件：新增 `docs/prd/backend-membership-prd.md`；更新本 README；GitHub 新增 `ready-for-agent` 标签与 PRD Issue #1。
- 后续建议：从 PRD Phase 0 锁定正式价格、额度和首发市场，然后按阶段顺序实施，每阶段通过验证门槛后再进入下一阶段。
