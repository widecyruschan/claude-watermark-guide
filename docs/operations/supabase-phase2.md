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

Email confirmation、refresh token rotation 與 TOTP 已啟用，Email OTP 為 8 位，重發間隔為 1 分鐘。Development 每小時可發 30 封測試郵件；Production 保留每小時 2 封的初始限制，上線前應配合正式 SMTP 與濫用防護再調整。

## Google OAuth

Google Provider 的設定骨架已放在 `supabase/config.toml`，本機預設保持關閉。取得 Google OAuth 憑據後，必須在 Google Cloud Console 加入以下 Authorized redirect URI：

```text
http://127.0.0.1:54321/auth/v1/callback
https://eazbgamyvkzzrnichqqw.supabase.co/auth/v1/callback
https://oyxdensbufzdzgmfuhyd.supabase.co/auth/v1/callback
```

再把 Client ID 與 Client Secret 分別寫入 Supabase dev/prod 的 Auth Provider Secret，不得寫入此文件或 `config.toml`。啟用後應分別測試 localhost、Pages preview 與正式域名跳轉。

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
