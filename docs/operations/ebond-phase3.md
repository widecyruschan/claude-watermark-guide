# EBond Phase 3 運維手冊

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
EBOND_BASE_URL=https://api.ebondai.com
EBOND_API_MODE=responses
EBOND_MODEL=gpt-5.5
SUPABASE_URL=https://PROJECT_REF.supabase.co
```

以下值只可使用 Cloudflare Pages production Secret，不得寫入 Git、日誌、`.env` 或 `.dev.vars`：

```text
EBOND_API_KEY
SUPABASE_SERVICE_ROLE_KEY
```

啟動 Provider 前會驗證 `EBOND_API_KEY` 只包含可安全放入 HTTP Header 的可打印 ASCII 字元。格式錯誤只回傳 `PROVIDER_CONFIGURATION_ERROR`，不會記錄或回傳 Secret 值。

`responses` 是預設協議。只有完成真實相容性測試並證明 Responses 不可用或缺少完整 usage 時，才可將 `EBOND_API_MODE` 明確改為 `chat_completions`。每個請求只使用一種協議，避免雙重供應商計費。

## 配額與冪等

`begin_rewrite_request` 在同一交易中取得唯一執行權並預留額度。`complete_rewrite_request` 原子寫入 Token、`cost_microusd` 與成功狀態；`fail_rewrite_request` 原子釋放額度並只保存標準錯誤碼。

同一會員重用相同 Idempotency Key 時：

- `processing`、`succeeded`、`failed` 均不會再次呼叫 EBond。
- 相同 Key 搭配不同輸入雜湊會回傳衝突。
- 原文與結果不寫入 `rewrite_requests` 或 `usage_ledger`。

EBond 成本以整數 micro-USD 記錄：

```text
round(input_tokens * 0.6 + output_tokens * 3.6)
```

## 失敗與日誌

429、502、503、504 最多短暫重試一次。timeout、取消和無 HTTP 狀態的傳輸失敗不重試。Provider 失敗會釋放額度；Provider 已成功但資料庫結算失敗時，會以相同參數重試三次並保留 reservation，避免錯誤釋放已產生成本的請求。最終失敗日誌會保留 request/user ID、Token 與成本，讓管理員在資料庫恢復後以相同參數受控重放冪等 `complete_rewrite_request`。

結構化日誌只包含 request/user ID、模型、Prompt 版本、字元/Token、成本、耗時、HTTP 狀態或標準失敗分類。無 HTTP 狀態的 Provider 失敗會額外呼叫一次不含使用者文字的 `/v1/models`，且只記錄 HTTP 狀態與指定模型是否存在。不得加入輸入、輸出、模型列表、Authorization、Cookie 或任何 Secret。

## 評測

`tests/fixtures/rewrite-evaluation.json` 包含 20 個非敏感的初步相容性樣本。腳本以數字、日期、專名、URL、引用和重要限定詞的事實錨點作自動 smoke gate，至少 95% 樣本必須保留所有錨點；它不能取代 50–100 個樣本的人工意義、新增事實與引用完整性審查。腳本只在記憶體檢查模型輸出，不保存或打印改寫內容：

```bash
REWRITE_EVALUATION_TOKEN="短期測試會員 JWT" npm run evaluate:rewrite
```

## 2026-08-16 聯調狀態

Supabase development/production 的 claim、settle、release、RLS 與重複 Key 測試均通過。Cloudflare Pages production 已配置 `EBOND_API_KEY` 及 `SUPABASE_SERVICE_ROLE_KEY` 兩個加密 Secret；EBond 公開設定統一為 `https://api.ebondai.com`、`gpt-5.5` 及 `responses`。

更新 production Secret 後，以不記錄 Key、請求文字或回應內容的最小直連檢查驗證：`GET /v1/models` 返回 HTTP 200 並包含 `gpt-5.5`；`POST /v1/responses` 返回 HTTP 200，且回應包含完整 input/output Token usage。這表示新 Key、帳戶權限、Responses 相容性及模型路由均可用，先前 Key 無上游 HTTP 狀態的問題已不再重現。

本次維護沒有使用真實會員 JWT 呼叫 production `POST /api/v1/rewrite`，因此 Cloudflare Pages、Supabase 配額及 EBond 的完整 production 端到端流程仍須由下一個受控會員請求確認。production 保持 `responses`；失敗請求會釋放額度，重複 Idempotency Key 不會再次計費。
