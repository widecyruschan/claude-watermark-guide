# Claude Watermark Guide — Static Site

Claude 隐形文本水印资讯 / 工具站（ShipSolo 流水线 01–09 产物）。
靜態前端 + Cloudflare Pages Functions API，Cloudflare Pages 兼容。

## 技術棧
- 原生 HTML / CSS / JavaScript
- Cloudflare Pages / Pages Functions / Wrangler
- TypeScript / Hono / Zod
- Vitest / ESLint / Prettier
- Supabase Auth / Postgres / Row Level Security

## 结构
- `index.html`                首頁（hero + 工具卡 + 導航卡）
- `pages/checker.html`        免費自測工具（純客戶端，文本不上傳）
- `pages/what-is-*.html`       解釋型文章（FAQPage 結構）
- `pages/how-it-works.html`    技術原理（公開部分，標 [待确认]）
- `pages/changes-2026.html`    近期變化時間線（標 [待确认] + 時效提示）
- `pages/privacy|terms|cookie` 法律頁（合規草稿）
- `css/style.css`             設計系統 token（IBM Plex / 單藍 accent / 4px 圓角）
- `js/checker.js`             客戶端啟發式（無 API、無上傳）
- `functions/api/[[route]].ts` Pages Functions API 入口
- `src/api/app.ts`            Hono API、請求 ID、驗證與錯誤合約
- `tests/api/`                API 行為測試
- `tests/database/`           Supabase Auth、RLS、配額與管理員整合測試
- `scripts/build.mjs`         靜態資源建置與頁面扁平化
- `supabase/`                 本機 Auth 設定、資料庫 schema 與方案 seed migrations
- `docs/prd/backend-membership-prd.md` 後台、會員、訂閱與管理功能 PRD
- `docs/operations/supabase-phase2.md` Supabase 環境、Auth、部署與管理員操作手冊
- `docs/operations/ebond-phase3.md` EBond 重寫 API、冪等、計費與聯調運維手冊
- `sitemap.xml` / `robots.txt` SEO 索引

## 待回填（標 [待确认] 項）
- `[DOMAIN]` → 真實域名（7 處：canonical + sitemap + robots）
- 文章頁真實來源引用（Help Center / Forbes / Reddit）
- 真實 GA4 / Clarity ID（目前 cookie banner 存在但未埋真實 SDK）
- /checker 是否 index（sitemap 默認 index，待確認）

## 部署到 Cloudflare Pages
1. 使用 Node.js 22 安裝依賴：`npm ci`
2. 執行完整檢查：`npm run check`
3. CLI 部署：`npx wrangler pages deploy dist --project-name claude-watermark-guide`
4. 綁定自訂域 + 替換 `[DOMAIN]`

## 本地預覽
```bash
npm install
npm run dev
```

Wrangler 預設在 `http://localhost:8788` 啟動靜態站與 Pages Functions。API 健康檢查為 `GET /api/v1/health`。

## 工程命令
- `npm run build`：產生扁平化的 `dist/` 靜態資源
- `npm run dev`：建置並啟動 Pages 本機執行環境
- `npm run evaluate:rewrite`：使用短期測試會員 JWT 執行不保存輸出的事實錨點評測
- `npm run format:check`：檢查新增工程檔案格式
- `npm run lint`：檢查 TypeScript 與建置腳本
- `npm run typecheck`：執行 TypeScript 嚴格型別檢查
- `npm test`：執行 Vitest 行為測試
- `npm run test:database`：對已啟動的本機 Supabase 執行 Auth、RLS 與配額整合測試
- `npm run admin:bootstrap`：以 server-only 環境變數提升一位已驗證管理員並記錄審計
- `npm run scan:secrets`：掃描原始碼與部署產物的常見密鑰格式
- `npm run test:smoke`：驗證首頁、工具頁與 Pages Functions 健康檢查
- `npm run check`：執行格式、Lint、型別、測試、建置、密鑰掃描與 smoke test

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

### 2026-08-15：完成 Phase 1 工程基礎
- 會話主要目的：建立後續後台與會員功能可持續開發、測試和部署的工程基礎。
- 完成的主要任務：加入 Node.js 22、TypeScript、Hono、Zod、Vitest、ESLint 和 Prettier；建立 Pages Functions API 入口、健康檢查、請求 ID、JSON 驗證及統一錯誤合約；統一本機與 CI 建置流程。
- 關鍵決策和解決方案：保持現有靜態前端不變；新 API 使用同一 Pages 專案的 Functions；測試以 HTTP API 外部行為為邊界；CI 在部署前強制執行格式、Lint、型別、測試、密鑰掃描與 Pages smoke test。
- 使用的技術棧：Node.js 22、TypeScript、Cloudflare Pages Functions、Hono、Zod、Vitest、ESLint、Prettier、Wrangler。
- 新增或修改檔案：新增 package 工具鏈、建置與安全腳本、Functions 入口、API 應用與行為測試；更新部署工作流程、README 和 lockfile。
- 後續建議：進入 Phase 2，建立 Supabase 開發/正式環境、認證、會員資料表、RLS 與原子額度操作。

### 2026-08-15：完成 Phase 2 Supabase 認證與資料庫
- 會話主要目的：建立獨立 Supabase dev/prod 環境，完成會員資料、權限與原子配額基礎。
- 完成的主要任務：建立新加坡 dev/prod 專案；配置 Magic Link Site URL、callback allowlist、Email confirmation、refresh rotation 與 TOTP；建立 7 張會員/訂閱/用量/審計資料表、Free/Pro 定義、首次登入 Profile 觸發器、RLS 和最小 grant；實作 service-role-only 的 reserve/settle/release 與管理員 bootstrap RPC。
- 關鍵決策和解決方案：瀏覽器只能讀自己的會員與用量資料並更新 display name；方案、角色、訂閱與 Ledger 均由伺服器控制；配額以 Usage Period row lock 序列化並以 immutable Ledger 保證冪等；資料庫密碼只存 macOS Keychain。
- 使用的技術棧：Supabase Auth、Postgres 17、PostgREST、RLS、PL/pgSQL、Supabase CLI、Vitest、GitHub Actions。
- 新增或修改檔案：新增 `supabase/config.toml`、Phase 2 migrations、資料庫整合測試、測試與管理員命令、Supabase 運維手冊；更新 package 工具鏈、CI 與 README。
- 後續建議：取得 Google OAuth Client ID/Secret 後啟用兩個遠端 Provider；管理員先完成一次產品登入，再執行受控 bootstrap 命令；Phase 3 以 Pages Functions 驗證 JWT 後呼叫 service-role-only 配額 RPC。

### 2026-08-15：加入首頁 Plausible 統計
- 會話主要目的：在網站首頁接入 `watermarklens.com` 的 Plausible 統計腳本並發布更新。
- 完成的主要任務：將 ShipSolo Plausible `defer` 腳本加入首頁 `<head>`，並驗證建置產物包含正確的統計域名與腳本來源。
- 關鍵決策和解決方案：只修改首頁，不把統計腳本擴展到文章、工具或法律頁面；保持腳本非同步延後載入。
- 使用的技術棧：原生 HTML、Plausible Analytics、Cloudflare Pages。
- 新增或修改檔案：修改 `index.html` 與本 README，未新增或提交任何密鑰或 `.env` 文件。
- 後續建議：部署後在 Plausible 即時面板確認首頁 pageview 到達，並依私隱政策決定是否調整 Cookie 文案。

### 2026-08-15：實作 Phase 3 EBond 重寫 API
- 會話主要目的：建立已認證、可計額、冪等且不保存文字內容的 EBond `gpt-5.5` 重寫 API。
- 完成的主要任務：實作 Responses 與顯式 Chat Completions 適配器、版本化 Prompt、輸入/Body 限制、Supabase JWT 驗證、原子 claim/settle/fail RPC、Token 成本、timeout/取消/重試、標準錯誤與脫敏日誌；將 migrations 和加密 Secret 配置到 dev/prod 並部署 production。
- 關鍵決策和解決方案：每個請求只使用一種明確協議，避免自動回退造成雙重計費；同一 Idempotency Key 只有首次 claim 可呼叫 Provider；資料庫只保存輸入雜湊和用量元資料；EBond 費用以整數 micro-USD 計算。
- 使用的技術棧：Cloudflare Pages Functions、Hono、Zod、Supabase Auth/Postgres/RLS、EBond Responses/Chat Completions、Vitest。
- 新增或修改檔案：新增 `src/rewrite/` 模組、Phase 3 migration、API/Provider/資料庫測試、20 樣本評測與 `docs/operations/ebond-phase3.md`；更新 API 入口、Wrangler、package scripts 與本 README。
- 後續建議：EBond 目前從 Cloudflare production 出站時沒有返回 HTTP 狀態，Responses 與 Chat 均無法完成；需供應商確認 Cloudflare Workers 可達性或提供來源地址，再重跑 95% 評測門檻。失敗請求已驗證會釋放額度，且一次性測試會員均已刪除。
