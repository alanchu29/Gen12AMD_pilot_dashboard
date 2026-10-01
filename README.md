# Gen12AMD_Pilot_gantt

C419E Gen12 / Gen12.1 NPI Pilot 排程儀表板。把 Excel 各分頁的 PFAM 排程轉成可互動的甘特圖：

- **專案總覽**：所有 PFAM 列在同一條時間軸上，時程條依階段分色（準備期／建置測試／出貨運輸），標示目前狀態、L10 Build / ETD / Dock 與相對基準的延遲，可依 Gen、廠區、階段、SKU 篩選。
- **PFAM 詳情**：點選後顯示 KPI、甘特圖（日 / 週 / 月、依負責單位或區段上色、基準比較、相依線、假日底色）、假設與風險。
- **PFAM 群組（1st + 2nd 合併）**：同一個 PFAM 的 1st / 2nd build 分頁在總覽合併成一列（上下兩條時程），詳情以 build 分道顯示；可切回「Excel 分頁」檢視。詳見下方「PFAM 群組」。
- **高亮我的任務**：負責欄含 STE / MTE（可在甘特圖工具列修改角色）的任務整列以黃色標示，也可切換「只看這些任務」；KPI 卡顯示下一個相關任務。
- **Raw data 表**：直接編輯任務，甘特圖即時重算。排程規則與 Excel 公式相同。
- **Google Sheet 同步（選用）**：用 Apps Script 當後端，多人共用同一份資料。

## PFAM 群組

- 自動分組：同 Gen + SKU（+ Lanai / PV3 Op1 等變體）的 **1st 與 2nd** 分頁合併；Pre GA 與其他分頁維持獨立。已封存的分頁不參與合併。
- 合併只發生在畫面上，每個分頁的資料、編輯、雲端同步都仍是獨立的；Raw data 表用分頁籤切換要編輯哪個 build。
- 2nd build 分頁的前段（準備／SKU Qual／Golden）多半是從 12.0 DV 複製、標示「=> same as 1st」的舊日期，因此在合併檢視中**只展開量產段**，其餘區段收合並標「沿用 1st」；若區段中過半任務的名稱與日期和其他分頁完全相同，另標「疑似複製」。展開即可看原始內容。
- 分組錯誤時，可在「專案資訊 → 合併群組」手動指定：輸入相同的群組名稱即合併，輸入 `-` 表示不合併，留空＝自動。

## 快速開始（本機）

直接用瀏覽器開啟 `index.html` 即可（不需要伺服器，也不需要安裝套件）。

編輯內容會自動存在這個瀏覽器的 localStorage。換電腦或清除瀏覽器資料前，請先用「資料 → 匯出 JSON 備份」保存。

## 排程規則（與 Excel 相同）

| 欄位 | Excel 原公式 | 網頁版 |
|---|---|---|
| 開始（依前置） | `=WORKDAY(XLOOKUP(前置, A:A, F:F), lag, Holiday!F:F)` | 開始規則 = 依前置，前置 = WBS，Lag = 位移工作天 |
| 開始（固定） | 直接輸入日期 | 開始規則 = 固定日期 |
| 結束 | `=WORKDAY(E, I-1, Holiday!F:F)` | 開始日 + 工作天（週末與廠區假日不計） |

- 日曆：每個 PFAM 有一個廠區假日曆（WYLZ / WYMX / …）。任務可改用「僅週末」或指定其他廠區。
- 在表格直接輸入開始日，會把任務改成「固定日期」（前置仍保留，切回「依前置」即可恢復）。
- 直接輸入結束日，會回推工作天數。
- 前置任務用內部 ID 連結，插入或移動列後 WBS 重新編號，相依關係不會斷。
- 刪除任務時，依賴它的任務會改為固定日期並保留原日期。
- 「基準」= 匯入時的 Excel 日期；可按「設為新基準」凍結目前排程，之後就能看到延遲 ▲ / 提前 ▼。

## 更新 Excel 資料（網頁上傳）

「資料 → 匯入新版 Excel…」選擇新版 xlsx，瀏覽器會直接解析（不需要 Python、不上傳到任何伺服器），並先顯示差異預覽：

| 類別 | 處理方式 |
|---|---|
| 將更新 | 新版 Excel 有變、網頁上沒改過 → 直接更新 |
| 需要你決定 | 新版 Excel 有變、網頁上也改過 → 逐頁選「用新版 Excel」或「保留網頁版本」 |
| 保留網頁修改 | Excel 沒變、網頁上改過 → 保留網頁版本 |
| 新分頁 / Excel 已無 | 以分頁名稱比對；改名（例如 `S (4)` → `S (5)`）會自動建議對應，也可手動指定 |

- 套用後，每個更新分頁的「基準」改為**上一版**的日期，▲▼ 直接顯示這一版 Excel 相較上一版的延後／提前（基準說明會標「上一版 Excel（檔名）」）。
- 假日表以新版 Excel 為準。網頁上建立的分頁（例如「複製為新情境」）一律保留。
- 套用後可從提示訊息按「復原匯入」。雲端模式下，匯入的變動先留在本機，按「同步到雲端」確認後才會寫入 Google Sheet。
- 不想逐頁比對時，可按預覽視窗的「**全部以新檔取代**」：內容完全以新檔為準，網頁上的修改、網頁建立的分頁、基準日期與手動合併群組都會捨棄（同名分頁沿用原本的 id，雲端同步時直接更新）。同樣可以「復原匯入」。
- Excel 裡**隱藏的分頁**視為過時的舊版本／情境，匯入時直接略過、不記錄也不顯示；先前匯入過的隱藏分頁會列在「Excel 已無」，預設移除。
- 分頁以 Excel 裡**一字不差**的名稱辨識（同一份檔案裡有 `x (3.5)` 與 `x (3.5) ` 兩個不同分頁）。

### 開發者：用 Python 產生內建資料

`data/seed.js` 是網頁第一次開啟時的內建資料，也可以用 Python 產生：

```bash
python tools/excel_to_seed.py "path/to/new.xlsx"
node tools/verify_engine.js                       # 網頁排程引擎 vs Excel 算出的日期
node tools/verify_importer.js "path/to/new.xlsx"  # 瀏覽器匯入器 vs Python 轉換器，輸出須完全相同
```

需求：Python 3 + `openpyxl`；Node.js（只有驗證腳本需要）。瀏覽器匯入使用 `js/vendor/xlsx.full.min.js`（SheetJS Community Edition 0.18.5，Apache-2.0）。

## 部署：GitHub Pages + Google Sheet

> ⚠ 資料可見範圍：GitHub Pages 網站是公開的，`data/seed.js`（完整排程）會隨網站發佈；Apps Script 以「所有人」部署時，拿到 `/exec` 網址的人都能讀取雲端資料（寫入受 `EDIT_KEY` 保護）。若要避免，請把 `data/seed.*` 排除在發佈之外，並妥善保管 `/exec` 網址。

### A. GitHub Pages（網頁）

1. 在 GitHub 建立 repo，把本專案 push 上去（`index.html` 在 repo 根目錄）。
2. repo → Settings → Pages → Build and deployment：Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)` → Save。（GitHub Pages 對 css/js 的快取是 10 分鐘：更新後其他人重新整理最慢 10 分鐘才會拿到新版，急用可按 Ctrl+F5。）
3. 約 1 分鐘後網址會出現在同一頁（`https://<帳號>.github.io/<repo>/`）。之後每次 push 都會自動更新。

### B. Google Sheet + Apps Script（共用資料）

1. 建立一份空白 Google 試算表（名稱自訂，例如 `Gen12AMD_Pilot_gantt DB`）→ 擴充功能 → Apps Script。
2. 刪掉預設的 `Code.gs` 內容，把本專案 `apps-script/Code.gs` 整份貼上 → 儲存。
3. 專案設定（齒輪）→ 指令碼屬性 → 新增 `EDIT_KEY` = 自訂密碼（只給需要編輯的人）。
4. 部署 → 新增部署作業 → 齒輪選「網頁應用程式」：執行身分 **我**、誰可以存取 **所有人** → 部署 → 依提示授權（出現「Google 尚未驗證這個應用程式」時：進階 → 前往專案）。
5. 複製「網頁應用程式」網址（結尾 `/exec`）。
6. 開啟 GitHub Pages 網頁 → 資料 → Google Sheet 雲端同步：貼上網址與 Edit key →「測試連線」→「上傳本機資料（覆蓋雲端）」（第一次，約數十秒）。回到試算表會看到 `PFAMs`、`Tasks`、`Holidays`、`Meta` 四個分頁。
7. 同一個對話框按「複製分享連結」，得到 `…/index.html?gas=<exec 網址>`，發給同事：點開即自動連上雲端（連結不含 Edit key；需要編輯的人再到「雲端同步」填入 Edit key）。
8. 讓一般網址直接就是雲端版：把 `/exec` 網址填入 `js/remote.js` 的 `DEFAULT_URL` 並 push。之後每次開啟網站都會先連雲端，本機資料只當備用：
   - 連不上雲端時，顯示此瀏覽器上次保存的雲端快照（沒有就用內建 `data/seed.js`），頂欄顯示「離線 · 本機備份」；每 60 秒、網路恢復或切回分頁時自動重試。
   - 載入雲端時若本機有未同步的修改，會詢問要改用雲端版本或保留本機修改（之後再按「同步到雲端」上傳，版本衝突時照一般衝突流程處理）。
   - 在「雲端同步」按停用只在本次有效，重新整理頁面就回到雲端。

試算表會自動建立四個分頁：`PFAMs`、`Tasks`（一列一個任務）、`Holidays`、`Meta`。

同步行為：
- 修改**不會自動上傳**：先存在這個瀏覽器，頂欄顯示橘色「本機修改 · 未同步」，頁面上方出現「目前顯示為本機修改版本」提示條。
- 按頂欄或提示條的「同步到雲端」，確認視窗列出要上傳的 PFAM，按確定才寫入 Google Sheet；也可按「捨棄本機修改」改回雲端版本。
- **看出哪裡和雲端不同**：有未同步修改的 PFAM 在總覽名稱旁有橘色 ⇪。點進去，KPI 下方的摘要列出與雲端版本相比「修改／新增／刪除／日期連動」的任務數與改過的專案資訊；甘特圖與 Raw data 表逐列標示 **改**（欄位改過，滑過可看改了哪些欄位）、**新**（雲端沒有）、**連動**（自己沒改、因前置任務變動而移動），並以紫色虛線框標出任務在雲端版本的位置。雲端有、本機已刪除的列在摘要裡展開查看。比對基準是最近一次從雲端載入（或上傳成功）的版本，重新整理後仍會保留。
- 每個 PFAM 有版本號。如果別人已先更新同一個 PFAM，會提示「載入雲端版本」或「以本機覆寫」，不會默默覆蓋。
- 讀取有快取：後端讀過一次試算表後，把結果存在 Apps Script 的 CacheService（最多 6 小時），之後開啟網頁不必重讀整份試算表。網頁寫入、或直接在試算表裡編輯（`onEdit`）都會清除快取。Apps Script 閒置一段時間後第一次呼叫仍需約 10 秒冷啟動；載入期間網頁先顯示這個瀏覽器上次的資料。
- 修改 `Code.gs` 後，要「管理部署作業 → 編輯 → 新版本」，網址才會套用新程式。

## 檔案結構

```
index.html            頁面
css/app.css           樣式（淺色 / 深色）
js/engine.js          排程引擎（WORKDAY / 相依 / 循環偵測），瀏覽器與 Node 共用
js/store.js           資料狀態、localStorage、復原 / 重做
js/portfolio.js       專案總覽
js/gantt.js           甘特圖
js/table.js           Raw data 編輯表
js/remote.js          Apps Script 用戶端（JSONP 讀取 / POST 寫入）
js/groups.js          PFAM 群組（1st + 2nd 合併檢視）
js/clouddiff.js       本機 vs 雲端差異（未同步標示、逐任務比對）
js/importer.js        Excel → 資料轉換（瀏覽器版，與 Python 轉換器輸出相同）
js/xlimport.js        匯入新版 Excel：差異預覽、套用、復原
js/vendor/            SheetJS（讀 xlsx，匯入時才載入）
js/app.js             整合、對話框、同步
data/seed.js|json     由 Excel 轉出的資料
apps-script/Code.gs   Google Apps Script 後端
tools/excel_to_seed.py      Excel → seed
tools/verify_engine.js      引擎 vs Excel 日期比對
tools/test_apps_script.js   Apps Script 往返測試（模擬 SpreadsheetApp）
tools/verify_importer.js    瀏覽器匯入器 vs Python 轉換器比對
```

## 快捷鍵

- `Ctrl+Z` / `Ctrl+Y`：復原 / 重做（游標不在輸入框時）
- 表格中 `Enter`：移到下一列的同一欄
- 總覽列表：`↑` `↓` 移動，`Enter` 開啟
- 甘特圖：雙擊任務跳到表格對應列
