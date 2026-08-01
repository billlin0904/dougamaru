# PureText YouTube 字幕擴充功能

這是可同時載入 Chrome 與 Edge 的 Manifest V3 擴充功能。它會呼叫 Audio-IO
的佇列式 Video Transcribe API，透過 SSE 接收逐段字幕，建立 SRT 時間軸並將
字幕疊加在目前的 YouTube 播放器上。

使用者需先透過 PureText API 登入。JWT 僅儲存在 `chrome.storage.local`，
登入後面板會顯示帳戶的剩餘轉譯分鐘數。登入與額度 API 位於
`https://website-builder-pro--billlin0904.replit.app/api`。
Extension 可使用 Email／密碼，或開啟網站既有的 Google OAuth；Google 登入
完成後會在網站的 `/auth/callback` 接收 JWT，再安全地交回 Extension。
OAuth 成功後會切回原本的 YouTube Tab，但不會自動關閉登入 Tab 或瀏覽器視窗。

> 所有請求都使用
> `POST https://gpuiapi.audio-io.com/api/youtube-live/jobs`。關閉「忽略
> YouTube 內建字幕」時送出 `ignore_subtitles: false`，優先使用內建字幕；
> 開啟時送出 `ignore_subtitles: true`，下載音軌並使用 Whisper。`language`
> 固定留空以自動偵測語言。SSE 的 `segment.text` 會被組合成 SRT；API 不提供
> 翻譯或原始字幕第二軌。

SSE `segment` 的 `progress_percent`、`elapsed_seconds`、
`processing_speed_x`、`estimated_remaining_seconds` 與
`estimated_completion_at` 會顯示在面板的進度卡片。最後進度會依 YouTube
影片 ID 儲存在 `chrome.storage.local`，切換 Tab 或重新開啟面板時會自動還原。
已有掛載字幕的影片可直接從面板下載 UTF-8 編碼的 `.srt` 字幕檔。
「隱藏字幕」只會關閉播放器上的字幕顯示，不會刪除字幕或影響 SRT 下載；
顯示偏好會保存在 `chrome.storage.local`。

## 建置

在 repository 根目錄執行：

```powershell
npm --prefix youtube-caption-extension install
npm --prefix youtube-caption-extension run build
```

可載入的擴充功能會輸出至：

```text
youtube-caption-extension/dist
```

## 載入 Chrome

1. 開啟 `chrome://extensions/`。
2. 開啟右上角「開發人員模式」。
3. 選擇「載入未封裝項目」。
4. 選取 `youtube-caption-extension/dist`。
5. 開啟或重新整理一部 YouTube 影片。
6. 點擊工具列的「PureText YouTube 字幕」圖示，在 YouTube 頁面內開啟浮動面板。

## 載入 Edge

1. 開啟 `edge://extensions/`。
2. 開啟「開發人員模式」。
3. 選擇「載入解壓縮的擴充功能」。
4. 選取 `youtube-caption-extension/dist`。
5. 開啟或重新整理一部 YouTube 影片，再從工具列開啟頁面內浮動面板。

## 開發注意事項

- 每次修改原始碼後要重新執行 build，再到擴充功能管理頁按「重新載入」。
- 已產生的 SRT 依 YouTube 影片 ID 儲存在 `chrome.storage.local`。
- API 請求由嵌入 YouTube 頁面的 Extension 面板送出，避免長時間轉錄被背景
  service worker 中止；它不經過 Vite proxy 或本機 `8080` API server。
- 若影片沒有 YouTube 現成字幕，Audio-IO 可能下載音軌並進行轉錄；請只處理
  你有權使用的內容。
