# 多租戶 MySQL Zero-Downtime Migration 完整流程

## 總覽架構圖
```mermaid
graph TB
    Start[開始 Migration] --> CheckVersion{檢查當前<br/>Schema Version}
    CheckVersion -->|v1| Phase1[階段1: Expand Migration]
    Phase1 --> Phase2[階段2: 雙寫模式]
    Phase2 --> Phase3[階段3: DMS 資料同步]
    Phase3 --> Phase4[階段4: 驗證與切換]
    Phase4 --> Phase5[階段5: Contract Migration]
    Phase5 --> End[完成]
```

## 詳細五階段流程

### 階段 1: Expand Migration (v1 → v1.5)
**目標：擴充 Schema，保留舊欄位**
```mermaid
sequenceDiagram
    participant App as 應用程式 v1
    participant OldDB as 舊資料庫<br/>(v1 → v1.5)
    participant Tool as Migration Tool
    
    Note over Tool: Flyway / Liquibase<br/>或自建腳本
    
    Tool->>OldDB: 1. 新增欄位 (nullable)
    Note right of OldDB: ALTER TABLE users<br/>ADD COLUMN username VARCHAR(100),<br/>ADD COLUMN email VARCHAR(255)
    
    Tool->>OldDB: 2. 背景執行 Backfill
    Note right of OldDB: UPDATE users<br/>SET username = user_name,<br/>email = CONCAT(...)<br/>WHERE username IS NULL<br/>LIMIT 10000
    
    Tool->>Tool: 3. 循環執行直到完成
    Tool->>OldDB: 4. 更新 schema_version = 'v1.5'
    
    App->>OldDB: 期間正常讀寫<br/>(只用舊欄位)
```

**使用服務/工具：**
- 🔧 **應用層**: Flyway、Liquibase、自建 Python/Node.js 腳本
- 🔧 **AWS**: 無 (純 SQL 操作)
- 🔧 **推薦工具**: pt-online-schema-change (大表)

---

### 階段 2: 雙寫模式
**目標：應用程式同時寫入新舊欄位**
```mermaid
sequenceDiagram
    participant User as 使用者
    participant App as 應用程式 v2<br/>(雙寫模式)
    participant OldDB as 舊資料庫<br/>(v1.5 schema)
    
    User->>App: 註冊新用戶
    
    rect rgb(255, 244, 225)
    Note over App,OldDB: 雙寫邏輯
    App->>OldDB: INSERT INTO users<br/>(user_name, username, email)<br/>VALUES ('Alice', 'Alice', 'a@ex.com')
    Note right of App: 同時寫入<br/>舊欄位 + 新欄位
    end
    
    OldDB-->>App: 寫入成功
    App-->>User: 註冊完成
    
    User->>App: 查詢用戶資料
    App->>OldDB: SELECT id, username, email<br/>FROM users WHERE id = 1
    Note right of App: 優先讀取新欄位
    OldDB-->>App: 返回資料
    App-->>User: 顯示資料
```

**使用服務/工具：**
- 🔧 **應用層**: 修改 ORM 層 (如 Sequelize, TypeORM, SQLAlchemy)
- 🔧 **AWS**: 無
- ⚠️ **注意事項**: 
  - 讀取時優先讀新欄位: `username ?? user_name`
  - 確保新舊欄位同步寫入

---

### 階段 3: DMS 資料同步 (Full Load + CDC)
**目標：複製資料到新資料庫並持續同步**
```mermaid
graph TB
    subgraph AWS["AWS DMS 架構"]
        Source[(舊資料庫<br/>v1.5 schema)]
        
        subgraph DMSInstance["DMS Replication Instance<br/>(c5.2xlarge)"]
            Task[Replication Task<br/>full-load-and-cdc]
        end
        
        Target[(新資料庫<br/>空白)]
        
        Source -->|1. Full Load| Task
        Task -->|2. Full Load| Target
        Source -->|3. CDC binlog| Task
        Task -->|4. CDC 同步| Target
    end
    
    subgraph Monitor["監控"]
        CW[CloudWatch Logs]
        Task --> CW
    end
    
    style Source fill:#e1f5ff
    style Target fill:#e8f5e9
    style DMSInstance fill:#fff4e1
    style Task fill:#fce4ec
```

或者使用更簡潔的版本：
```mermaid
flowchart LR
    Source[(舊資料庫<br/>v1.5)]
    DMS[DMS Instance<br/>c5.2xlarge]
    Target[(新資料庫<br/>空白)]
    CW[CloudWatch]
    
    Source -->|Full Load| DMS
    DMS -->|Full Load| Target
    Source -.->|CDC<br/>binlog| DMS
    DMS -.->|CDC<br/>即時同步| Target
    DMS --> CW
    
    style Source fill:#e1f5ff
    style Target fill:#e8f5e9
    style DMS fill:#fff4e1
```

或者用序列圖方式呈現（最穩定）：
```mermaid
sequenceDiagram
    participant Source as 舊資料庫<br/>(v1.5)
    participant DMS as DMS Instance
    participant Target as 新資料庫
    participant CW as CloudWatch
    
    Note over Source,Target: Phase 1: Full Load
    DMS->>Source: 讀取全部資料
    Source-->>DMS: 返回資料
    DMS->>Target: 批次寫入
    Note right of DMS: 8個平行任務<br/>每批10,000筆
    
    Note over Source,Target: Phase 2: CDC (持續進行)
    Source->>DMS: binlog 變更事件
    DMS->>Target: 即時同步變更
    Note right of DMS: 延遲 < 5秒
    
    DMS->>CW: 上報監控指標
```

**推薦使用序列圖版本**，因為它最穩定且能清楚表達時序關係。

或者用更簡單的圖表：
```mermaid
graph LR
    A[舊資料庫 v1.5] -->|Full Load| B[DMS Task]
    B -->|Full Load| C[新資料庫]
    A -.->|CDC| B
    B -.->|CDC| C
    B --> D[CloudWatch]
  
```

選擇最適合您的版本即可！建議使用序列圖，因為它最能清楚呈現 DMS 的運作流程。

**使用服務/工具：**
- ☁️ **AWS DMS**: Replication Instance, Endpoints, Tasks
- ☁️ **Amazon RDS**: 源和目標資料庫
- ☁️ **CloudWatch**: 監控 DMS 任務狀態、延遲
- ☁️ **SNS**: 發送告警通知

**關鍵配置：**
```json
{
  "MigrationType": "full-load-and-cdc",
  "FullLoadSettings": {
    "MaxFullLoadSubTasks": 8,
    "CommitRate": 10000
  },
  "ChangeProcessingTuning": {
    "BatchApplyEnabled": true,
    "MinTransactionSize": 1000
  }
}
```

---

### 階段 4: 驗證與切換
**目標：確認資料一致性後切換流量**
```mermaid
sequenceDiagram
    participant Admin as 管理員
    participant Monitor as 監控系統
    participant App as 應用程式
    participant OldDB as 舊資料庫
    participant NewDB as 新資料庫
    participant DMS as DMS Task
    
    Admin->>Monitor: 1. 檢查 Full Load 完成
    Monitor->>DMS: 查詢任務狀態
    DMS-->>Monitor: FullLoadProgressPercent: 100%
    
    Admin->>Monitor: 2. 檢查 CDC 延遲
    Monitor->>DMS: 查詢 CDC 延遲
    DMS-->>Monitor: CDCLatency: 2 秒
    
    Admin->>Monitor: 3. 驗證資料一致性
    Monitor->>OldDB: SELECT COUNT(*) FROM users
    OldDB-->>Monitor: 50,000,000
    Monitor->>NewDB: SELECT COUNT(*) FROM users
    NewDB-->>Monitor: 50,000,000
    
    Monitor->>Monitor: 4. 比對關鍵資料 checksum
    Note right of Monitor: SELECT MD5(GROUP_CONCAT(...))<br/>FROM users<br/>ORDER BY id LIMIT 10000
    
    rect rgb(255, 235, 238)
    Note over Admin,NewDB: 切換流量
    Admin->>App: 5. 更新資料庫連線配置
    Note right of App: DB_HOST = new-db-endpoint
    Admin->>App: 6. 重新部署應用程式
    App->>NewDB: 開始讀寫新資料庫
    end
    
    Admin->>DMS: 7. 停止 DMS Task
    Note right of Admin: 觀察 1-2 天<br/>確認穩定後停止
```

**使用服務/工具：**
- ☁️ **CloudWatch Dashboards**: 監控關鍵指標
- ☁️ **CloudWatch Alarms**: CDC 延遲、錯誤率告警
- 🔧 **應用層**: 資料一致性驗證腳本
- ☁️ **AWS Systems Manager**: 更新應用程式配置
- ☁️ **Elastic Load Balancer**: 流量切換 (如果使用)

---

### 階段 5: Contract Migration (v1.5 → v2)
**目標：清理舊欄位，完成 Schema 升級**
````mermaid
sequenceDiagram
    participant Admin as 管理員
    participant App as 應用程式 v3
    participant NewDB as 新資料庫<br/>(v1.5 到 v2)
    
    Note over Admin,NewDB: 等待 3-7 天確認穩定
    
    Admin->>NewDB: 1. 執行 Contract Migration
    Note right of NewDB: ALTER TABLE users<br/>DROP COLUMN user_name
    
    Admin->>NewDB: 2. 刪除其他舊欄位
    
    Admin->>NewDB: 3. 更新索引
    Note right of NewDB: 刪除舊索引<br/>建立新索引
    
    Admin->>NewDB: 4. 更新 schema_version
    Note right of NewDB: UPDATE schema_versions<br/>SET version = 'v2'
    
    Admin->>App: 5. 部署應用程式 v3
    Note right of App: 完全移除<br/>雙寫邏輯
    
    App->>NewDB: 只使用新欄位
    Note right of App: SELECT username, email<br/>FROM users
````

或者使用更簡單的流程圖版本：
````mermaid
graph TB
    Start[Contract Migration 開始] --> Step1[刪除舊欄位]
    Step1 --> Step2[更新索引]
    Step2 --> Step3[更新 schema_version]
    Step3 --> Step4[部署應用程式 v3]
    Step4 --> End[Migration 完成]
    
    Step1 -.->|SQL| SQL1[ALTER TABLE users<br/>DROP COLUMN user_name]
    Step2 -.->|SQL| SQL2[DROP INDEX idx_user_name<br/>CREATE INDEX idx_username]
    Step3 -.->|SQL| SQL3[UPDATE schema_versions<br/>SET version = v2]
````

**Contract Migration 步驟清單：**
````markdown
1. **刪除舊欄位**
```sql
   ALTER TABLE users DROP COLUMN user_name;
```

2. **更新索引**
```sql
   DROP INDEX idx_user_name ON users;
   CREATE INDEX idx_username ON users(username);
```

3. **更新 schema version**
```sql
   UPDATE schema_versions 
   SET version = 'v2', 
       updated_at = NOW();
```

4. **部署應用程式 v3**
   - 移除雙寫邏輯
   - 只使用新欄位 (username, email)

5. **驗證**
```sql
   -- 確認舊欄位已刪除
   SHOW COLUMNS FROM users;
   
   -- 確認應用程式正常運作
   SELECT username, email FROM users LIMIT 10;
```
````

推薦使用**流程圖版本**，因為它更清楚且不會有語法錯誤問題！

**使用服務/工具：**
- 🔧 **應用層**: Flyway、Liquibase
- 🔧 **AWS**: 無
- ⚠️ **注意事項**: 
  - 在非尖峰時段執行
  - 先備份再刪除
  - 保留回滾腳本

---

## 完整時間軸視圖
```mermaid
gantt
    title Multi-tenant MySQL Migration Timeline
    dateFormat YYYY-MM-DD
    section 階段1: Expand
    舊DB新增欄位           :a1, 2024-01-01, 1d
    背景 Backfill         :a2, after a1, 2d
    
    section 階段2: 雙寫
    部署雙寫應用程式       :b1, after a2, 1d
    雙寫模式運行          :b2, after b1, 3d
    
    section 階段3: DMS
    建立DMS實例與任務     :c1, after b1, 1d
    Full Load            :c2, after c1, 1d
    CDC 持續同步          :c3, after c2, 7d
    
    section 階段4: 切換
    驗證資料一致性        :d1, after c2, 1d
    應用程式切換          :d2, after d1, 1d
    監控穩定性            :d3, after d2, 3d
    
    section 階段5: Contract
    執行Contract清理      :e1, after d3, 1d
    部署最終版本          :e2, after e1, 1d
```

---

## Schema 版本演進圖
```mermaid
graph LR
    V1[v1 Schema<br/>────────<br/>user_name<br/>phone] 
    -->|Expand| V15[v1.5 Schema<br/>────────<br/>user_name 舊<br/>username 新<br/>phone<br/>email 新]
    -->|Contract| V2[v2 Schema<br/>────────<br/>username<br/>email]
    
    style V1 fill:#ffebee
    style V15 fill:#fff9c4
    style V2 fill:#e8f5e9
    
    V1 -.->|❌ 不能直接跳| V2
```

**欄位對照表：**
| v1 | v1.5 (過渡期) | v2 |
|---|---|---|
| user_name | user_name ✅<br/>username ✅ | username ✅ |
| phone | phone ✅ | phone ✅ |
| - | email ✅ | email ✅ |

---

## 多租戶批次部署策略
```mermaid
graph TB
    Start[選擇租戶群組] --> Canary{金絲雀測試<br/>1-2 個租戶}
    
    Canary -->|成功| Wave1[第一波<br/>10% 租戶]
    Canary -->|失敗| Rollback[回滾並修復]
    
    Wave1 -->|成功| Wave2[第二波<br/>20% 租戶]
    Wave1 -->|失敗| Pause1[暫停調查]
    
    Wave2 -->|成功| Wave3[第三波<br/>30% 租戶]
    Wave2 -->|失敗| Pause2[暫停調查]
    
    Wave3 -->|成功| Final[剩餘租戶<br/>40%]
    Wave3 -->|失敗| Pause3[暫停調查]
    
    Final --> Complete[全部完成]
    
    style Canary fill:#fce4ec
    style Wave1 fill:#e1f5ff
    style Wave2 fill:#e8f5e9
    style Wave3 fill:#fff4e1
    style Final fill:#f3e5f5
```

**批次策略：**
```python
租戶分組：
- 金絲雀 (1%): 內部測試租戶
- 第一波 (10%): 小型租戶 (< 100萬筆)
- 第二波 (20%): 中型租戶 (100萬-1000萬筆)
- 第三波 (30%): 大型租戶 (1000萬-5000萬筆)
- 最終波 (40%): 超大租戶 (> 5000萬筆)

每波間隔: 24-48 小時
```

---

## AWS 服務使用總覽
```mermaid
graph TB
    subgraph "資料層"
        RDS1[Amazon RDS<br/>舊資料庫]
        RDS2[Amazon RDS<br/>新資料庫]
    end
    
    subgraph "遷移服務"
        DMS[AWS DMS<br/>資料同步]
    end
    
    subgraph "監控告警"
        CW[CloudWatch<br/>Logs + Metrics]
        SNS[SNS<br/>告警通知]
    end
    
    subgraph "應用層"
        App[應用程式<br/>EC2/ECS/Lambda]
        SSM[Systems Manager<br/>配置管理]
    end
    
    subgraph "管理工具"
        Script[Migration Scripts<br/>Flyway/自建]
    end
    
    Script --> RDS1
    RDS1 --> DMS
    DMS --> RDS2
    App --> RDS1
    App --> RDS2
    DMS --> CW
    CW --> SNS
    SSM --> App
    
    style RDS1 fill:#e1f5ff
    style RDS2 fill:#e8f5e9
    style DMS fill:#fff4e1
    style CW fill:#fce4ec
```

**服務責任分工：**

| 階段 | AWS 服務 | 應用層工具 |
|-----|---------|-----------|
| Expand Migration | - | Flyway, Liquibase, pt-osc |
| 雙寫模式 | - | ORM 修改, 應用程式邏輯 |
| 資料同步 | **DMS**, RDS, CloudWatch | - |
| 驗證切換 | CloudWatch, SNS, SSM | 自建驗證腳本 |
| Contract Migration | - | Flyway, Liquibase |

---

## 監控指標儀表板
```mermaid
graph TB
    subgraph "DMS 監控"
        M1[Full Load Progress<br/>目標: 100%]
        M2[CDC Latency<br/>目標: < 5秒]
        M3[CDCChangesPending<br/>目標: < 1000]
    end
    
    subgraph "資料庫監控"
        M4[CPU Utilization<br/>目標: < 70%]
        M5[Database Connections<br/>目標: < 80%]
        M6[Replication Lag<br/>目標: < 10秒]
    end
    
    subgraph "應用層監控"
        M7[Error Rate<br/>目標: < 0.1%]
        M8[Response Time<br/>目標: < 200ms]
        M9[Data Consistency<br/>定期驗證]
    end
    
    style M1 fill:#e8f5e9
    style M2 fill:#fff4e1
    style M3 fill:#fce4ec
    style M4 fill:#e1f5ff
    style M5 fill:#f3e5f5
    style M6 fill:#ffebee
```

---

## 回滾計畫
```mermaid
graph TB
    Issue{發現問題} --> Type{問題類型}
    
    Type -->|階段1-2<br/>Expand/雙寫| R1[回滾方案1]
    Type -->|階段3<br/>DMS同步| R2[回滾方案2]
    Type -->|階段4<br/>已切換| R3[回滾方案3]
    Type -->|階段5<br/>Contract| R4[回滾方案4]
    
    R1 --> R1A[1. 停止雙寫<br/>2. 刪除新欄位<br/>3. 回退應用]
    R2 --> R2A[1. 停止DMS<br/>2. 應用繼續用舊DB<br/>3. 刪除新DB資料]
    R3 --> R3A[1. 切換DNS回舊DB<br/>2. 檢查資料差異<br/>3. 重新同步]
    R4 --> R4A[❌ 無法回滾<br/>需從備份還原]
    
    style R1 fill:#e8f5e9
    style R2 fill:#fff4e1
    style R3 fill:#ffebee
    style R4 fill:#f44336,color:#fff
```

---

## 成本估算表

| 項目 | 規格 | 用量 | 單價 (USD) | 小計 |
|-----|------|------|-----------|------|
| DMS Instance | c5.2xlarge | 24 hrs | $0.492/hr | $11.81 |
| RDS Storage | 500 GB | 1 month | $0.115/GB/mo | $57.50 |
| Data Transfer | 跨AZ | 500 GB | $0.01/GB | $5.00 |
| CloudWatch Logs | 10 GB | 1 month | $0.50/GB | $5.00 |
| **單租戶總計** | - | - | - | **~$79** |
| **100租戶總計** | - | - | - | **~$7,900** |

*價格以 ap-northeast-1 為準，實際費用可能因地區而異*

---

## 常見問題 FAQ

### Q1: 為什麼不能先 Migration 新 DB 再用 CDC？
**A**: 因為 CDC 會嘗試將舊 schema 的變更套用到新 schema，欄位不匹配會導致同步失敗。

### Q2: DMS 能處理多大的資料量？
**A**: 理論上無限制，實測過 TB 級資料。關鍵是：
- 選擇適當的 Instance 規格
- 調整 BatchApply 參數
- 分批處理大型租戶

### Q3: 如果 Full Load 期間舊 DB 有寫入怎麼辦？
**A**: DMS 會：
1. 記錄 Full Load 開始時的 binlog 位置
2. Full Load 完成後，從該位置開始 CDC
3. 補上 Full Load 期間的變更

### Q4: 需要停機嗎？
**A**: 不需要！整個流程都是零停機：
- Expand: 在線上執行
- DMS: 背景同步
- 切換: 秒級 DNS/配置更新

### Q5: 多久可以完成？
**A**: 依資料量而定：
- 5000萬筆: 約 2-3 週
  - Expand: 2-3 天
  - DMS Full Load: 1-2 天
  - 驗證穩定: 1 週
  - Contract: 1 天