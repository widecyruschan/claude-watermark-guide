# Supabase Phase 2 運維手冊

## 環境

| 環境 | Project | Region | 用途 |
| --- | --- | --- | --- |
| Development | `claude-watermark-guide-dev` (`eazbgamyvkzzrnichqqw`) | Singapore `ap-southeast-1` | 整合測試、預覽與開發 |
| Production | `claude-watermark-guide-prod` (`oyxdensbufzdzgmfuhyd`) | Singapore `ap-southeast-1` | 正式會員、訂閱與用量資料 |

資料庫密碼只存於本機 macOS Keychain，服務名稱為 `supabase-db-password`，帳號名稱分別為 `claude-watermark-guide-dev` 與 `claude-watermark-guide-prod`。不得將密碼、API Key、Access Token、`.env` 或 `.dev.vars` 寫入 Git。

## Auth URL

Development Site URL：

```text
http://localhost:8788
```

Production Site URL：

```text
https://watermarklens.com
```

兩個環境均允許以下登入完成跳轉：

```text
http://localhost:8788/auth/callback
http://127.0.0.1:8788/auth/callback
https://watermarklens.com/auth/callback
https://www.watermarklens.com/auth/callback
https://claude-watermark-guide.pages.dev/auth/callback
https://*.claude-watermark-guide.pages.dev/auth/callback
```

Email confirmation 與 refresh token rotation 已啟用，Email OTP 為 8 位，重發間隔為 1 分鐘。Development 每小時可發 30 封測試郵件；Production 保留每小時 2 封的初始限制，上線前應配合正式 SMTP 與濫用防護再調整。

## Google OAuth

Google Provider 的設定骨架已放在 `supabase/config.toml`，本機預設保持關閉。取得 Google OAuth 憑據後，必須在 Google Cloud Console 加入以下 Authorized redirect URI：

```text
http://127.0.0.1:54321/auth/v1/callback
https://eazbgamyvkzzrnichqqw.supabase.co/auth/v1/callback
https://oyxdensbufzdzgmfuhyd.supabase.co/auth/v1/callback
```

本機變數模板已建立於被 Git 忽略的 `.env.local`：

```text
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=
```

填入本機值後，在啟動 Supabase 前把變數載入目前 shell：

```bash
set -a
source .env.local
set +a
npx supabase start
```

Hosted development 及 production 專案不會讀取本機 `.env.local`。必須分別前往 Supabase Dashboard 的 Authentication → Providers → Google，填入相同欄位：

| Supabase 欄位 | 本機變數 |
| --- | --- |
| Client ID | `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` |
| Client Secret | `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` |

完成後啟用 Google Provider，並分別測試 localhost、Pages preview 及正式網域跳轉。Client Secret 不得加入 Cloudflare Pages、前端程式碼、此文件或 `supabase/config.toml`。

### 網站登入流程

網站使用 Supabase JS PKCE 流程：

1. `/login` 從 `GET /api/v1/auth/config` 取得 Supabase URL 及 publishable key。
2. 用戶按 Google 登入後，Supabase 把 PKCE verifier 保存在瀏覽器 storage，並跳轉 Google。
3. Google 驗證完成後返回 `/auth/callback`；頁面以 `exchangeCodeForSession` 建立 Supabase session。
4. 成功後清除 callback URL 參數並跳轉 `/account`。
5. `/account` 恢復及自動 refresh session，顯示 Profile、有效方案、帳單狀態、目前週期及剩餘字符；`SIGNED_OUT` 或 refresh 後無 session 會返回 `/login`。

Pages Functions 需要以下 binding：

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

`SUPABASE_PUBLISHABLE_KEY` 按 Supabase 設計可公開給瀏覽器，但專案仍透過 Cloudflare binding 及被 Git 忽略的 `.dev.vars` 注入，不寫入原始碼。公開配置 endpoint 會驗證 URL 及 key 格式，配置缺失時回傳標準化 HTTP 503。

Google Client ID／Secret 只由 Supabase Auth 使用。Cloudflare production 目前仍存在兩個舊的 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`／`SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` binding；應在取得產品負責人明確批准後刪除，以縮小 Secret 存放範圍。應用程式不讀取或輸出這兩個 binding。

## 本機驗證

```bash
npx supabase start
npx supabase db reset
npm run test:database
npx supabase db lint --local --level warning
```

`test:database` 從本機 Supabase 狀態讀取臨時角色密鑰，只傳給 Vitest 子程序。測試完成後會刪除建立的 Auth 使用者。

## 部署遷移

先在 Development dry-run，再實際推送：

```bash
db_password="$(security find-generic-password -a claude-watermark-guide-dev -s supabase-db-password -w)"
npx supabase db push --project-ref eazbgamyvkzzrnichqqw --password "$db_password" --dry-run --skip-vault
npx supabase db push --project-ref eazbgamyvkzzrnichqqw --password "$db_password" --skip-vault
unset db_password
```

Development 驗證通過後，才以相同流程將 migration 推到 Production。Production 不可使用 `--include-seed`。

## 建立首位管理員

管理員必須先在目標環境完成一次已驗證登入，確保 Profile 已由資料庫觸發器建立。之後由受控終端注入 Supabase URL、server-only service role/secret key 與管理員 Email：

```bash
SUPABASE_URL="https://PROJECT_REF.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
SUPABASE_ADMIN_EMAIL="admin@example.com" \
npm run admin:bootstrap
```

命令只允許提升已驗證使用者，呼叫只授權 `service_role` 的 `bootstrap_administrator` 函數，並新增 `administrator.bootstrap` 審計紀錄。瀏覽器角色無法執行此函數。

## 配額操作

`reserve_quota`、`settle_quota` 與 `release_quota` 僅授權 `service_role`。Pages Functions 必須先驗證會員 JWT，再以 server-only Supabase key 傳入該使用者 ID。瀏覽器不能直接寫入 Subscription、Usage Period 或 Usage Ledger，也不能呼叫配額 RPC。
