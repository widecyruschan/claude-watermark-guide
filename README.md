# Claude Watermark Guide — Static Site

Claude 隐形文本水印资讯 / 工具站（ShipSolo 流水线 01–09 产物）。
靜態前端 + Cloudflare Pages Functions API，Cloudflare Pages 兼容。

## 技術棧
- 原生 HTML / CSS / JavaScript
- Cloudflare Pages / Pages Functions / Wrangler
- TypeScript / Hono / Zod
- Vitest / ESLint / Prettier
- Supabase Auth / Postgres / Row Level Security
- Stripe Checkout / Customer Portal / signed Webhooks

## 结构
- `index.html`                首頁（hero + 工具卡 + 導航卡）
- `pages/checker.html`        免費自測工具（純客戶端，文本不上傳）
- `pages/login.html`          Google OAuth 登入頁
- `pages/account.html`        會員 Profile、方案、週期、用量及登出
- `auth/callback.html`        Supabase PKCE callback 及 session exchange
- `pages/what-is-*.html`       解釋型文章（FAQPage 結構）
- `pages/how-it-works.html`    技術原理（公開部分，標 [待确认]）
- `pages/changes-2026.html`    近期變化時間線（標 [待确认] + 時效提示）
- `pages/privacy|terms|cookie` 法律頁（合規草稿）
- `css/style.css`             設計系統 token（IBM Plex / 單藍 accent / 4px 圓角）
- `js/checker.js`             客戶端啟發式（無 API、無上傳）
- `functions/api/[[route]].ts` Pages Functions API 入口
- `src/api/app.ts`            Hono API、請求 ID、驗證與錯誤合約
- `src/client/auth.ts`        瀏覽器 Supabase Auth、callback、session 及會員資料
- `tests/api/`                API 行為測試
- `tests/database/`           Supabase Auth、RLS、配額與管理員整合測試
- `scripts/build.mjs`         靜態資源建置與頁面扁平化
- `supabase/`                 本機 Auth 設定、資料庫 schema 與方案 seed migrations
- `docs/prd/backend-membership-prd.md` 後台、會員、訂閱與管理功能 PRD
- `docs/operations/supabase-phase2.md` Supabase 環境、Auth、部署與管理員操作手冊
- `docs/operations/ebond-phase3.md` EBond 重寫 API、冪等、計費與聯調運維手冊
- `docs/operations/stripe-phase5.md` Stripe Checkout、Portal、Webhook 與 Test mode 運維手冊
- `sitemap.xml` / `robots.txt` SEO 索引

## 已確認的產品設定
- 正式網域：`watermarklens.com`
- 私隱及支援聯絡電郵：`contact@watermarklens.com`
- 首發市場及語言：美國／英文
- 分析服務：首頁使用 Plausible-compatible 無 Cookie 統計，不使用 GA4 或 Microsoft Clarity
- AI 單次輸入上限：Free 3,000 字符；Pro 20,000 字符
- AI 控制：語氣下拉選單、正式程度低／中／高、重寫強度低／中／高；輸出自動保留輸入語言

## 尚待確認
- Pro 正式價格，以及 Free／Pro 正式月度字符額度
- 語氣下拉選單的正式 allowlist
- 文章頁真實來源引用（Help Center / Forbes / Reddit）
- `/checker` 是否繼續允許搜尋引擎索引（sitemap 目前包含此頁）
- Privacy、Cookie、Terms 草案的正式法律審核、營運主體名稱、適用州法及爭議處理條款
- EBond 的合約資料保留期；production 帳戶及 `gpt-5.5` Responses 路由已驗證可用

## 部署到 Cloudflare Pages
1. 使用 Node.js 22 安裝依賴：`npm ci`
2. 執行完整檢查：`npm run check`
3. CLI 部署：`npx wrangler pages deploy dist --project-name claude-watermark-guide`
4. 確認 `watermarklens.com` 自訂網域、DNS 與 Auth redirect URL

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

### 2026-08-16：完成 Phase 1–3 全站與 API QA
- 會話主要目的：檢查 Phase 1–3 工程更新、全部公開頁面路由、響應式畫面、互動功能與所有 API/資料庫連線，修復可控問題後重新部署。
- 完成的主要任務：遍歷首頁、Checker、三個內容頁、三個法律頁與 404；驗證桌面/手機、控制台、內部連結、Plausible、健康與錯誤 API；修復 Checker 結果永遠隱藏、空輸入無提示、手機導航截斷、Cookie 橫幅失效及分析政策不一致；新增三組 QA 回歸測試與 EBond 安全連線診斷。
- 關鍵決策和解決方案：Plausible 官方標準腳本不使用 Cookie，因此移除不需要的同意橫幅並同步 Privacy/Cookie 文案；EBond 診斷只記錄安全狀態與模型存在與否，不記錄 Key、輸入、輸出或模型列表。
- 使用的技術棧：Cloudflare Pages/Workers、原生 HTML/CSS/JavaScript、Hono、Vitest、Supabase Auth/Postgres/RLS、Plausible、EBond API。
- 新增或修改檔案：修改 Checker、首頁、CSS、Privacy/Cookie、EBond Provider/API/運維手冊與本 README；新增 Checker、分析政策、EBond Secret/連線診斷回歸測試；本機保留完整 QA 報告與 38 張證據截圖。
- 後續建議：Phase 1/2 與 Phase 3 的認證、冪等、配額釋放均通過；EBond production Key/帳戶對 `/v1/models`、Responses 與 Chat 均未返回上游 HTTP 狀態，需 EBond 檢查該帳戶及 `gpt-5.5` 路由。內容頁的 `[待確認]` 必須取得正式來源、日期與私隱聯絡資料後再移除。

### 2026-08-16：鎖定首發設定並整理法律草案
- 會話主要目的：記錄已確認的網域、聯絡方式、首發市場、重寫控制及單次字符限制，並將 Privacy、Cookie、Terms 整理為可審閱草案。
- 完成的主要任務：確認 `watermarklens.com`、`contact@watermarklens.com` 及 US/English 首發；定義語氣、正式程度、重寫強度與自動保留輸入語言的產品要求；擴寫三份英文法律頁並加入回歸測試。
- 關鍵決策和解決方案：Free／Pro 單次上限鎖定為 3,000／20,000 字符；月度額度、Pro 價格及語氣 allowlist 仍維持待確認；AI 原文和結果預設不落庫，但法律草案不替 EBond 承諾尚未確認的保留期。
- 使用的技術棧：原生 HTML、Cloudflare Pages、Supabase、EBond AI、Plausible-compatible Analytics、Vitest。
- 新增或修改檔案：更新 `docs/prd/backend-membership-prd.md`、`pages/privacy.html`、`pages/cookie.html`、`pages/terms.html`、`README.md`；新增 `tests/legal-pages.test.ts`。未建立或提交任何 `.env`、密碼、Token 或 API Key。
- 後續建議：由美國法律顧問確認營運主體、適用州法、爭議處理、退款及州級私隱披露；在 Phase 4 開發前確認語氣 allowlist，並在付費上線前鎖定正式價格和月度額度。

### 2026-08-16：更新 EBond production Secret 並完成最小聯調
- 會話主要目的：將 EBond 網關統一為 `https://api.ebondai.com`，安全更新 Cloudflare Pages production 的 `EBOND_API_KEY`，並確認 `gpt-5.5` Responses API 可用。
- 完成的主要任務：核對 `wrangler.toml` 的公開設定；透過 Wrangler 互動式輸入更新加密 Secret；確認遠端只顯示 Secret 名稱及加密狀態；執行不輸出請求／回應文字的 `/v1/models` 與 `/v1/responses` 最小檢查。
- 關鍵決策和解決方案：密鑰只存在 Cloudflare production Secret 及單次程序記憶體，不寫入命令參數、原始碼、日誌、`.env` 或 `.dev.vars`；直連檢查確認模型列表和 Responses 均返回 HTTP 200，且 usage 欄位完整。
- 使用的技術棧：Cloudflare Pages、Wrangler、EBond API、`gpt-5.5`、Responses API。
- 新增或修改檔案：更新 `docs/operations/ebond-phase3.md` 與本 README 的非敏感聯調狀態；未新增或提交任何密碼、Token、API Key、`.env` 或 `.dev.vars`。
- 後續建議：使用短期測試會員 JWT 對 production `POST /api/v1/rewrite` 執行一次受控端到端請求；由於密鑰曾進入聊天記錄，應在 EBond 後台輪換後再以相同步驟更新 Cloudflare Secret。

### 2026-08-16：PRD 轉為香港繁體中文
- 會話主要目的：把後台及會員系統 PRD 由中英混合內容完整轉為香港繁體中文。
- 完成的主要任務：翻譯問題陳述、解決方案、40 條用戶故事、功能需求、資料模型、API contract、測試策略、Phase 0–8、驗收準則、範圍及風險；保留 API 路徑、程式識別字及第三方技術名稱。
- 關鍵決策和解決方案：統一使用香港常用的「用戶、登入、登出、電郵、私隱、帳單、伺服器、資料庫、網絡」等詞彙；`low`／`medium`／`high`、error code、Secret 名稱及 Mermaid 技術標識維持原文，避免影響開發 contract。
- 使用的技術棧：Markdown、Mermaid、Cloudflare Pages、Supabase、Stripe、EBond API。
- 新增或修改檔案：完整翻譯 `docs/prd/backend-membership-prd.md`，並更新本 README 會話記錄；未修改程式邏輯，亦未新增任何密碼、Token、API Key、`.env` 或 `.dev.vars`。
- 後續建議：後續 PRD 更新繼續使用香港繁體中文；產品正式價格、月度配額及語氣 allowlist 確認後，同步更新 PRD、資料庫 seed 及前端文案。

### 2026-08-16：建立 Google OAuth 伺服器變數模板
- 會話主要目的：為 Supabase Google OAuth 產生可由產品負責人填寫的伺服器變數，不把 Client Secret 放入 Cloudflare 或 Git。
- 完成的主要任務：建立被 Git 忽略的本機 `.env.local` 空白模板；確認 `supabase/config.toml` 已引用對應變數；補充本機載入方式、dev／prod Supabase Dashboard 欄位及 Google Authorized redirect URI。
- 關鍵決策和解決方案：Google OAuth 由 Supabase Auth 處理，使用 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` 及 `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`；Hosted 專案必須在 Supabase Dashboard 填寫，Cloudflare Pages 不保存 Google Client Secret。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0、Supabase CLI、Shell environment variables。
- 新增或修改檔案：本機新增已被忽略的 `.env.local`；更新 `docs/operations/supabase-phase2.md` 及本 README。模板不含真實憑據，亦不會被 Git 追蹤。
- 後續建議：填入 Google Client ID／Secret 後，先測試本機 callback，再啟用 dev 及 production Provider，最後驗證 Pages preview 與 `watermarklens.com` 登入流程。

### 2026-08-16：Google OAuth 遠端配置測試
- 會話主要目的：以不建立帳戶的方式驗證 Supabase development／production Google OAuth Provider、Google callback 參數及網站登入完成路由。
- 完成的主要任務：分別呼叫兩個 hosted Supabase `/auth/v1/authorize?provider=google` endpoint；檢查 production 及 Pages preview 的 `/auth/callback`；搜尋原始碼及 build artifact 是否包含 OAuth callback handler。
- 關鍵決策和解決方案：兩個 Supabase 專案均返回 HTTP 400、`validation_failed` 及 `Unsupported provider: provider is not enabled`，因此沒有進入 Google 帳戶選擇或建立 Auth 用戶；兩個網站 callback URL 均返回 404，原始碼只有 allowlist，尚未實作 `signInWithOAuth` 或 `exchangeCodeForSession`。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0、Cloudflare Pages、HTTP redirect validation。
- 新增或修改檔案：只追加本 README 測試記錄；未更改 Supabase／Google 設定、未建立測試帳戶，亦未讀取或輸出 Client Secret。
- 後續建議：在 dev／production Supabase Dashboard 分別開啟 Google Provider 並儲存，然後實作及部署 `/auth/callback` session exchange；完成後重新執行 redirect 及實際登入測試。

### 2026-08-16：Google OAuth 配置重試
- 會話主要目的：在 Supabase 設定更新後重新驗證 development／production Google OAuth redirect 及 Google 授權頁。
- 完成的主要任務：重新呼叫兩個 Supabase authorize endpoint；驗證 production 會以 HTTP 302 跳轉至 Google，並確認 Supabase callback URI 完全正確；使用瀏覽器只讀取 Google 授權錯誤頁，沒有選擇帳戶或提交登入。
- 關鍵決策和解決方案：production Google Provider 已啟用，但 Google 返回 HTTP 401 `invalid_client` 及「OAuth client was not found」，表示 Supabase 內的 production Client ID 無效、已刪除或來自錯誤 Google Cloud 專案；development Provider 仍未啟用；production／preview 的 `/auth/callback` 仍返回 404。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0、Cloudflare Pages、Chrome。
- 新增或修改檔案：只追加本 README 測試記錄；未修改 Google／Supabase 設定、未提交登入、未建立 Auth 用戶，亦未記錄 Google 帳戶或 OAuth Client ID。
- 後續建議：從 Google Cloud Console 的 Web application OAuth 2.0 credential 重新複製完整 Client ID 至 production Supabase 並儲存；啟用 development Provider；實作及部署 `/auth/callback` session exchange 後再重試完整登入。

### 2026-08-16：定位 Production Supabase Google Provider
- 會話主要目的：說明 Production Supabase 的正確專案及 Google Provider 設定入口。
- 完成的主要任務：確認 production 專案為 `claude-watermark-guide-prod`，project ref 為 `oyxdensbufzdzgmfuhyd`，並核對 Supabase 官方 Google Provider 設定路徑。
- 關鍵決策和解決方案：Google Client ID／Secret 應填入 Supabase Dashboard 的 Authentication → Providers → Google，而不是 Cloudflare Pages 變數。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0。
- 新增或修改檔案：只追加本 README 會話記錄；未修改任何 Supabase／Google 設定，亦未處理或保存憑據。
- 後續建議：在 production 專案重新貼上有效的 Web application Client ID，啟用 Google Provider 並儲存後再次測試。

### 2026-08-16：Google OAuth 第二次重試
- 會話主要目的：再次驗證 production Google Client ID 更新後的 Supabase OAuth redirect 及 Google 授權狀態。
- 完成的主要任務：確認 production Supabase 仍可正確跳轉至 Google，Client ID 參數存在且 callback 精確匹配；在不顯示帳戶或 Client ID 的情況下檢查 Google 錯誤訊號。
- 關鍵決策和解決方案：Google 仍返回 HTTP 401 `invalid_client` 及「OAuth client was not found」，未進入帳戶選擇；development Provider 仍未啟用，production／preview `/auth/callback` 仍返回 404。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0、Cloudflare Pages、Chrome。
- 新增或修改檔案：只追加本 README 測試記錄；未修改遠端設定、未提交登入、未建立 Auth 用戶，亦未保存 Google 帳戶或 OAuth Client ID。
- 後續建議：確認 Google Cloud Console 目前所選 Project 正確，從 Google Auth Platform → Clients 開啟未被刪除的 Web application credential，重新複製完整 Client ID 至 production Supabase 並按 Save；等待約一分鐘後再測試。

### 2026-08-16：Google OAuth 第三次重試
- 會話主要目的：確認更新後的 production Google Client ID 是否已獲 Google 接受，並重新檢查 OAuth 返回路徑。
- 完成的主要任務：驗證 production Supabase 正確跳轉 Google、Client ID 存在、Supabase callback URI 匹配；確認 Google 不再返回 `invalid_client` 或 `redirect_uri_mismatch`，並成功返回 `watermarklens.com/auth/callback`。
- 關鍵決策和解決方案：現有瀏覽器 Google session 自動完成驗證，因此 production Supabase 可能已建立或更新 Auth 用戶；應用程式 callback 仍返回 404，未能在前端保存 Supabase session；development Provider 仍未啟用。
- 使用的技術棧：Supabase Auth、Google OAuth 2.0、Cloudflare Pages、Chrome。
- 新增或修改檔案：只追加本 README 測試記錄；未刪除或修改 Auth 用戶、未更改遠端設定，亦未記錄 Google 帳戶、OAuth Client ID 或 callback credential。
- 後續建議：實作及部署 `/auth/callback` session 處理，再驗證登入後 session、Profile 建立、refresh 及登出；如需 development 測試，另行啟用 development Google Provider。

### 2026-08-16：確定 Google OAuth callback 處理方案
- 會話主要目的：說明 Production Google OAuth 已通過後，應如何處理應用程式 callback 404 及 session 建立。
- 完成的主要任務：確定不再修改 Google Client 或 production Provider；建議在現有靜態站使用 Supabase JS PKCE 流程，加入登入入口、`/auth/callback`、session 恢復、登出及錯誤狀態。
- 關鍵決策和解決方案：將來源頁面建立為 `auth/callback.html` 並輸出至 `dist/auth/callback.html`，讓 Cloudflare Pages clean URL 提供 `/auth/callback`；callback 只使用公開 Supabase URL／publishable key 交換 code，絕不把 Google Client Secret、Supabase service-role key 或 EBond Key 放入前端。
- 使用的技術棧：Supabase Auth JS、Google OAuth 2.0、PKCE、Cloudflare Pages、原生 HTML／TypeScript。
- 新增或修改檔案：只追加本 README 決策記錄；未實作或部署認證程式碼，亦未修改遠端設定。
- 後續建議：下一個開發工作應實作 login／callback／account session 最小垂直流程，加入 callback、refresh、logout 及 RLS 測試後再部署。

### 2026-08-16：實作 Google OAuth 會員登入流程
- 會話主要目的：完成 Production Google OAuth 的應用程式 callback、session、會員帳戶及登出流程，移除 `/auth/callback` 404 阻塞。
- 完成的主要任務：加入 `/login`、`/auth/callback`、`/account`；以 Supabase JS PKCE 交換 code；加入 session 持久化、自動 refresh、過期／登出處理；顯示 Profile、有效方案、帳單狀態、週期及真正剩餘字符；建立公開 Auth config endpoint 及 esbuild browser bundle。
- 關鍵決策和解決方案：前端只取得 Supabase URL 及 publishable key，service-role／Google／EBond Secret 不進入 browser bundle；callback 支援重複載入時恢復已存在 session；方案顯示使用與資料庫配額一致的 active／trialing 及有效期規則；配置錯誤回傳標準化 HTTP 503。
- 使用的技術棧：Supabase Auth JS、Google OAuth 2.0、PKCE、TypeScript、esbuild、Cloudflare Pages Functions、Vitest。
- 新增或修改檔案：新增登入、callback、會員頁、`src/client/auth.ts` 及五組 Auth 測試；更新 API、build、smoke、樣式、首頁、Supabase 運維手冊、package 工具鏈及本 README；本機 `.dev.vars` 保持 Git ignored，未提交任何 Secret。
- 後續建議：部署後完成真實 Google 登入、callback、Profile、refresh 及 logout 驗證；development Google Provider、Magic Link、刪除帳戶及完整會員選單仍屬後續 Phase 4 工作。

### 2026-08-16：Production 實質登出驗證
- 會話主要目的：以已登入的 production 瀏覽器工作階段，驗證實質登出及受保護帳戶頁的存取控制。
- 完成的主要任務：觸發帳戶頁登出；確認導向 `/login`、Google 登入按鈕可用；再直接存取 `/account`，確認未有 session 時會自動導回 `/login`。
- 關鍵決策和解決方案：驗證只檢查路由與可見登入狀態，不讀取或輸出瀏覽器 Cookie、storage、Google 電郵、授權碼或 session token；最終 URL 不含 OAuth code 或 access／refresh token。
- 使用的技術棧：Supabase Auth、Google OAuth、Cloudflare Pages、production 瀏覽器端到端驗證。
- 新增或修改檔案：只追加本 README 測試記錄；未修改應用程式程式碼、Supabase 設定、Cloudflare Secret、`.env` 或其他憑據。
- 後續建議：如要在本機或 preview 環境重現登入流程，先啟用 development Supabase 的 Google Provider；Magic Link、帳戶刪除與完整計費 Portal 仍屬後續工作。

### 2026-08-16：完成 Phase 4 會員介面
- 會話主要目的：為會員建立 Magic Link／Google 登入、AI 重寫工作區、帳戶用量與帳戶刪除的完整前端流程。
- 完成的主要任務：新增 `/rewrite` 頁面與語氣、正式程度、重寫強度控制；支援取消、錯誤、結果、複製及下載；加入 Magic Link、帳戶 menu、session 過期草稿保留、用量進度及響應式版面；加入需最近登入的帳戶刪除 API、匿名化與 Auth soft delete。
- 關鍵決策和解決方案：重寫草稿只留在當前瀏覽器分頁的 `sessionStorage`，不落資料庫；控制選項同時經 API allowlist 驗證並納入版本化 Prompt 和冪等雜湊；本機 Checker 保持免登入、零上傳，並明確與 AI 重寫分開；無 Stripe Checkout 前只顯示升級提示，不提供失效付款操作。
- 使用的技術棧：原生 HTML/CSS、TypeScript、Supabase Auth、Cloudflare Pages Functions、EBond API、Postgres/RLS、Vitest、Wrangler 本機 smoke 及瀏覽器響應式驗證。
- 新增或修改檔案：新增重寫頁、瀏覽器端重寫流程、帳戶刪除 migration 和 API 測試；更新認證、重寫契約/Prompt、樣式、首頁、Checker、建置和 smoke 測試；未建立或提交 `.env`、Cloudflare Secret、Supabase service-role key、Google Secret 或 EBond Key。
- 後續建議：部署前先對 production 套用 `20260816093000_phase4_account_deletion.sql`；啟用 production Magic Link 模板並用實際測試帳戶驗證；Stripe Checkout、Portal 及真正 Pro 付款升級仍屬 Phase 5。

### 2026-08-16：Phase 4 最終驗收
- 會話主要目的：完成 Phase 4 會員介面、資料庫 migration 及 API 的最終建置前驗收。
- 完成的主要任務：重新驗證 session refresh、過期後草稿保留、最近驗證刪除帳戶流程、登入／帳戶路由與響應式會員頁；確認受版本控制檔案不含 `.env`、`.dev.vars` 或實際憑據。
- 關鍵決策和解決方案：production 必須先套用 `20260816093000_phase4_account_deletion.sql`，再部署含帳戶刪除端點的版本，避免前端先公開而資料庫函數尚未存在。
- 使用的技術棧：TypeScript、Supabase Auth/Postgres、Cloudflare Pages Functions、Vitest、Playwright、Supabase CLI。
- 新增或修改檔案：追加本 README 驗收記錄；未建立、讀取、修改或提交任何 Secret、`.env` 或本機憑據檔。
- 驗證結果：`npm run check`（51 passed、8 skipped）、`npm run test:e2e`（4 passed）、`npm run test:database`（8 passed）、`npx supabase db lint --local --level warning` 及 `git diff --check` 均通過。
- 後續建議：在 development 及 production 套用 migration 後，以新建測試會員完成 Magic Link、Google、Free／Pro 權益、session 過期及刪除帳戶的實際遠端驗證；不可使用正式帳戶測試刪除。

### 2026-08-16：統一全站導航與路由
- 會話主要目的：修正登入、法律頁、內容頁及 404 頁的導航不一致問題。
- 完成的主要任務：所有公開路由統一顯示 Home、What Is、How It Works、What Changed、Free Checker、AI Rewriter 及 Sign in；會員頁保留登入後 Account menu，並在 session 恢復後隱藏重複的 Sign in 入口。
- 關鍵決策和解決方案：導航使用同一組公開路由連結，頁面品牌連結統一回到首頁；不把需要 session 的 Account menu 暴露給訪客。
- 使用的技術棧：原生 HTML/CSS、TypeScript、Supabase Auth、Vitest、Playwright、Cloudflare Pages smoke test。
- 新增或修改檔案：更新所有 HTML header、會員導航狀態切換、導航回歸測試及完整公開路由 smoke test；未建立或提交任何 Secret、`.env` 或 `.dev.vars`。
- 驗證結果：所有頁面源碼導航矩陣通過；`npm run check`、`npm run test:e2e`（5 項）及完整 Pages smoke 路由檢查通過。
- 後續建議：部署後在 `watermarklens.com/privacy`、`/terms`、`/cookie`、`/login` 及 `/404` 實際點擊確認自訂網域 rewrite 規則與導航一致。

### 2026-08-16：實作 Phase 5 Stripe 訂閱帳單
- 會話主要目的：建立 Stripe Test mode Checkout、Customer Portal、signed Webhook 及會員帳單狀態流程。
- 完成的主要任務：加入 server-only Pro Price mapping、已驗證 Checkout／Portal API、raw-body Webhook signature、事件冪等及順序保護、Subscription／Usage Period 同步、週期結束取消、固定三日 past-due 寬限、會員帳單操作介面，以及刪除帳戶前先取消仍可收費的 Stripe Subscription。
- 關鍵決策和解決方案：瀏覽器只可提交空 JSON，不可選擇 Price 或 redirect origin；完整 Webhook payload 不落庫；Stripe identifier 只供 service-role 使用；Checkout、Subscription 及 Invoice 使用獨立事件水位及嚴格 identifier 配對，防止舊 Session／Subscription 覆寫目前帳單；正式價格未確認前不建立 Product／Price 或啟用 production Checkout。
- 使用的技術棧：Stripe Node SDK、Cloudflare Pages Functions、Supabase Auth/Postgres/RLS、TypeScript、Vitest、Playwright。
- 新增或修改檔案：新增 `src/billing/`、`src/account/`、Phase 5 migration、API／Provider／資料庫／帳戶刪除測試及 `docs/operations/stripe-phase5.md`；更新會員帳戶頁、重寫 entitlement、Wrangler binding、package 工具鏈及本 README。
- 驗證結果：`npm run check`（68 passed、18 skipped）、`npm run test:database`（18 passed）、`npm run test:e2e`（5 passed）、Supabase schema lint、`npm audit`、`git diff --check` 及 Secret 掃描均通過；signed fixture 已完整通過 Worker API 至 Supabase，但尚未使用真實 Stripe Test mode credential。
- 安全狀態：未使用或提交任何真實 Stripe Secret、`.env` 或 `.dev.vars`；正式 Pro 價格、幣別、Product、Price ID、API Secret 及 Webhook Secret 仍未配置。
- 後續建議：確認 Pro 月費及幣別後，在 Stripe Test mode 建立 Product／Price，配置 Customer Portal、Webhook endpoint 及 Cloudflare encrypted Secrets，再用新建測試會員完成真實生命週期驗收。
