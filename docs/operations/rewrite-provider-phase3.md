# AI 重寫供應商 Phase 3 運維手冊

## API 合約

`POST /api/v1/rewrite` 只接受以下 JSON：

```json
{
  "text": "需要改寫的文字"
}
```

請求必須包含有效的 Supabase Bearer JWT 與 UUID 格式的 `Idempotency-Key`。全域上限為 20,000 個 Unicode 字元及 100 KiB 原始 Body；Free 與 Pro 的單次及週期額度仍由資料庫方案定義。

## Cloudflare 綁定

公開變數保存在 `wrangler.toml`：

```text
REWRITE_BASE_URL=https://breakout.wenwen-ai.com
REWRITE_API_MODE=chat_completions
REWRITE_MODEL=gpt-5.5
SUPABASE_URL=https://PROJECT_REF.supabase.co
```

以下值只可使用 Cloudflare Pages production Secret，不得寫入 Git、日誌、`.env` 或 `.dev.vars`：

```text
REWRITE_API_KEY
SUPABASE_SERVICE_ROLE_KEY
```

啟動 Provider 前會驗證 `REWRITE_API_KEY` 只包含可安全放入 HTTP Header 的可打印 ASCII 字元。格式錯誤只回傳 `PROVIDER_CONFIGURATION_ERROR`，不會記錄或回傳 Secret 值。

問問現時以 OpenAI-compatible Chat Completions 提供 `gpt-5.5`，正式 endpoint 為 `POST /v1/chat/completions`。每個請求只使用一種協議，避免自動回退造成雙重供應商計費。

程式只接受上述 `REWRITE_*` binding，不會讀取或混用舊 `EBOND_*` 值。完成 production 切換後，可從 Cloudflare 刪除舊 `EBOND_API_KEY`。

## 配額與冪等

`begin_rewrite_request` 在同一交易中取得唯一執行權並預留額度。`complete_rewrite_request` 原子寫入 Token、`cost_microusd` 與成功狀態；`fail_rewrite_request` 原子釋放額度並只保存標準錯誤碼。

同一會員重用相同 Idempotency Key 時：

- `processing`、`succeeded`、`failed` 均不會再次呼叫問問 API。
- 相同 Key 搭配不同輸入雜湊會回傳衝突。
- 原文與結果不寫入 `rewrite_requests` 或 `usage_ledger`。

問問 `gpt-5.5` 成本以整數 micro-USD 記錄：

```text
round(input_tokens * 0.5 + output_tokens * 3.0)
```

## 失敗與日誌

429、502、503、504 最多短暫重試一次。timeout、取消和無 HTTP 狀態的傳輸失敗不重試。Provider 失敗會釋放額度；Provider 已成功但資料庫結算失敗時，會以相同參數重試三次並保留 reservation，避免錯誤釋放已產生成本的請求。最終失敗日誌會保留 request/user ID、Token 與成本，讓管理員在資料庫恢復後以相同參數受控重放冪等 `complete_rewrite_request`。

結構化日誌只包含 request/user ID、模型、Prompt 版本、字元/Token、成本、耗時、HTTP 狀態或標準失敗分類。無 HTTP 狀態的 Provider 失敗會額外呼叫一次不含使用者文字的 `/v1/models`，且只記錄 HTTP 狀態與指定模型是否存在。不得加入輸入、輸出、模型列表、Authorization、Cookie 或任何 Secret。

## 評測

`tests/fixtures/rewrite-evaluation.json` 包含 20 個非敏感的初步相容性樣本。腳本以數字、日期、專名、URL、引用和重要限定詞的事實錨點作自動 smoke gate，至少 95% 樣本必須保留所有錨點；它不能取代 50–100 個樣本的人工意義、新增事實與引用完整性審查。腳本只在記憶體檢查模型輸出，不保存或打印改寫內容：

```bash
REWRITE_EVALUATION_TOKEN="短期測試會員 JWT" npm run evaluate:rewrite
```

## 2026-08-17 供應商切換狀態

程式及 migration 已切換至 `provider='wenwen'`，歷史 `provider='ebond'` 記錄不會被改寫。公開設定統一為 `https://breakout.wenwen-ai.com`、`gpt-5.5` 及 `chat_completions`。

Production 已配置 Cloudflare Pages encrypted Secret `REWRITE_API_KEY`，並已套用最新 Supabase migration。Token 沒有進入 `wrangler.toml`、`.env`、`.dev.vars`、GitHub Actions log 或瀏覽器程式碼。

受控 production 會員請求仍回傳 `PROVIDER_UNAVAILABLE`。已清理的 Cloudflare runtime 診斷顯示 Worker 至問問網關在 transport 層失敗，連 `GET /v1/models` 探測亦未取得 HTTP 狀態；同一官方 endpoint 從本機可正常取得未授權 HTTP 回應。這表示 Supabase migration、Cloudflare Secret 名稱及應用程式 route 已生效，剩餘阻塞位於問問網關與 Cloudflare Workers 的網絡／TLS 相容性。供應商確認正式可用入口前，不得改用未列入官方文件的域名或第三方代理。
