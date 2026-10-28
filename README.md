# test
## API 註冊申請流程（HAMP-362 驗證）

到 [Issues → New issue](https://github.com/KE-CY/test/issues/new/choose) 選一張申請範本送出，
workflow 會解析內容、產生設定檔、跑驗證，然後開一個 PR 回來並在 issue 留言。

| 範本 | 什麼時候用 | 行為 |
| --- | --- | --- |
| **申請新增** | 全新產品第一次註冊；既有產品開通**還沒建立過**的環境 | 只建立。環境已存在會被擋下 |
| **申請更新** | 其餘所有後續調整 | 換 OpenAPI、新增或修改 scope、改 owner / base_path。不能刪 |
| **申請移除** | 下架指定環境 | 只刪勾選的環境；全部勾選等於整個產品下架 |

共同規則：

- `產品編號`、`產品負責人 email`、`對外路徑前綴` 一律必填。新增與移除時這三個欄位必須與既有註冊相符，當成「有沒有搞錯產品」的確認；要變更只能走更新。
- OpenAPI **只接受拖曳上傳的 `.yaml` 附件**，不接受外部連結，也不接受 `.json`。
- 驗證沒過會把錯誤訊息留言到 issue，修正後重新編輯 issue 即可重跑。
- 同一個產品同時只允許一張進行中的申請 PR。

`products/S0001` 是預先放好的範例產品（registry 不可為空），可以拿來測更新與移除。

### 本地驗證

```bash
npm ci
npm run check                            # registry 驗證 + OpenAPI lint + 單元測試
./scripts/dry-run-issue.sh add body.md   # 用 issue 內容在暫存目錄模擬，不動到 repo
```

### 檔案

| 檔案 | 作用 |
| --- | --- |
| `.github/ISSUE_TEMPLATE/api-{add,update,remove}.yml` | 三張申請範本，各自帶 `request:*` 標籤 |
| `.github/workflows/issue-to-pr.yml` | issue opened/edited → 產檔 → 驗證 → 開 PR |
| `scripts/issue-to-files.mjs` | 解析 issue 表單、抓附件、套用到 `products/` |
| `scripts/validate.mjs` | registry 與 OpenAPI 的規則檢查 |
| `test/issue-to-files.test.mjs` | 24 個情境的單元測試 |
