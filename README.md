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
- 不提供去除/破解水印功能
- 不聲稱官方合作 / 100% 準確 / 永久免費 / 無限
- 工具頁已寫「啟發式、非官方、不保證準確」
