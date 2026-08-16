# Stripe Phase 5 訂閱帳單運維手冊

## 實作狀態

應用程式已實作以下 Test mode 能力：

- `POST /api/v1/billing/checkout`：已驗證會員建立固定 Pro Price 的 Checkout Session。
- `POST /api/v1/billing/portal`：已綁定 Stripe Customer 的會員建立短效 Portal Session。
- `POST /api/v1/webhooks/stripe`：以 raw body 驗證 `Stripe-Signature`，再以冪等 RPC 同步 Subscription。
- `customer.subscription.created|updated|deleted`：同步方案、狀態、週期、取消標記及 Stripe identifier。
- `invoice.payment_failed`：記錄 `past_due` 及三日寬限期。
- `invoice.paid`：付款恢復後清除寬限期。
- `checkout.session.expired`：解除 payment processing，允許會員重新開啟 Checkout。
- 刪除帳戶：如仍有可收費 Subscription，先由伺服器即時取消，成功後才匿名化會員及 soft-delete Auth 用戶。

完整 Webhook payload 不會寫入資料庫或日誌，只保存 event ID、類型、狀態及 SHA-256。

Checkout、Subscription 及 Invoice 分別保存事件時間水位。Checkout 事件必須匹配目前 Session；Subscription／Invoice 事件必須匹配目前 Subscription ID。若 Subscription 事件早於 Checkout completed 到達，API 會暫時回傳可重試錯誤，待 Checkout 綁定正確 Subscription ID 後再安全處理。

## 尚待產品設定

正式 Pro 月費及幣別尚未確認，因此本輪不建立 Stripe Product／Price，亦不啟用 production Checkout。現有資料庫的 `price_cents` 只屬早期 seed，不可用作建立正式 Stripe Price 的授權依據。

確認價格後，在 Stripe Dashboard **Test mode** 建立：

1. Product：`Watermark Lens Pro`
2. Price：Recurring、Monthly、USD、正式確認的金額
3. Metadata：`plan_code=pro`

應用程式只接受伺服器端 `STRIPE_PRO_PRICE_ID`，瀏覽器提交的 Price ID 或 redirect URL 會被拒絕。

## Cloudflare 配置

以下值只可加入 Cloudflare Pages encrypted Secret，不可寫入 Git、`wrangler.toml`、README、日誌、`.env` 或 `.dev.vars`：

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRO_PRICE_ID
```

`APP_BASE_URL=https://watermarklens.com` 是非敏感 server binding，已保存於 `wrangler.toml`。Test／production 必須使用不同 Stripe credential；不可把 `sk_test_` 與 `whsec_` 值複製至 production live mode。

Wrangler 會以互動提示讀取 Secret，值不應放入命令參數：

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name claude-watermark-guide
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name claude-watermark-guide
npx wrangler pages secret put STRIPE_PRO_PRICE_ID --project-name claude-watermark-guide
```

## Stripe Webhook destination

Test mode endpoint：

```text
https://watermarklens.com/api/v1/webhooks/stripe
```

訂閱以下事件：

```text
checkout.session.completed
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_failed
invoice.paid
```

Webhook signing secret 來自這個 endpoint 本身，不可與 Stripe API Secret Key 混用。Webhook signature 驗證必須使用原始 request body；任何 JSON 解析都只能在驗證成功後進行。

## Customer Portal

在 Stripe Test mode 啟用 Customer Portal configuration，至少允許：

- 更新付款方法
- 取消月度訂閱，並在目前週期結束時生效
- 查看帳單歷史

Portal return URL 固定為 `https://watermarklens.com/account`。瀏覽器不能覆寫此 URL。

## 資料庫 migration

先對 development dry-run 及 push：

```bash
db_password="$(security find-generic-password -a claude-watermark-guide-dev -s supabase-db-password -w)"
npx supabase db push --project-ref eazbgamyvkzzrnichqqw --password "$db_password" --dry-run --skip-vault
npx supabase db push --project-ref eazbgamyvkzzrnichqqw --password "$db_password" --skip-vault
unset db_password
```

development 驗證完成後，才將 `20260816170000_phase5_stripe_billing.sql` 推到 production。Production 不可使用 `--include-seed`。

## Test mode 驗收

本機 fixture 已覆蓋：

- Checkout 只使用 server-side Pro Price 及固定 origin
- raw-body signature 有效／無效路徑
- 重播同一 event 不會再次修改 Subscription
- 第二個待處理 Checkout、舊 Checkout Session 及已取代 Subscription 不會覆蓋目前狀態
- 較舊 Subscription event 可更新週期資料，但不會覆蓋較新的 Invoice 付款狀態
- 週期結束取消仍保留 Pro 至期末
- `past_due` 三日內保留 Pro，重複付款失敗不會延長寬限，逾期後套用 Free 上限
- 有效 Subscription 的帳戶刪除會先取消 Stripe；取消失敗時不會刪除會員資料
- browser 不能直接呼叫 billing RPC 或讀取 Stripe identifier
- signed Stripe payload 可完整通過 Worker API、signature adapter 及 Supabase RPC 寫入 Subscription

取得 Test mode credential 後，仍須使用新建測試會員完成一次真實 Checkout、Portal、續期、付款失敗及取消流程。不得使用正式帳戶、live mode 卡或 production 真實付款資料測試。

Stripe Test Clock 可用時，應以 Test Clock 驗證續期及三日寬限；未配置 Test Clock 時，現有固定時間 fixture 是等價的自動化狀態轉換測試，但不取代 Stripe Dashboard 的端到端測試。

## 官方參考

- [Stripe Checkout subscriptions](https://docs.stripe.com/payments/checkout/how-checkout-works)
- [Customer Portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Webhook signature verification](https://docs.stripe.com/webhooks/signature)
- [Stripe Node Cloudflare Worker template](https://github.com/stripe-samples/stripe-node-cloudflare-worker-template)
