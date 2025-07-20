# 打包說明

## 打包配置

本專案使用 `electron-builder` 進行打包，配置已針對路徑問題進行優化。

### 檔案結構

#### 開發環境
```
distributed-llm-inference/
├── src/
├── bin/
│   ├── windows/
│   ├── linux/
│   └── macos/
├── models/
│   ├── README.md
│   └── *.gguf (用戶放置)
└── package.json
```

#### 打包後結構
```
app/
├── resources/
│   ├── bin/               # 正確位置：resources/bin/
│   │   ├── windows/
│   │   ├── linux/
│   │   └── macos/
│   └── app/
│       ├── src/
│       ├── models/        # 僅包含 README.md
│       └── node_modules/
```

### 路徑處理

應用程式使用以下邏輯處理路徑：

```javascript
const basePath = app.isPackaged 
  ? process.resourcesPath                   // 打包後：/resources/
  : path.join(__dirname, '../..');          // 開發中：專案根目錄

const binPath = path.join(basePath, 'bin', osMap[platform], binaryName);
const modelsPath = path.join(basePath, 'models');
```

### 打包命令

```bash
# 開發模式
npm run dev

# 打包當前平台
npm run build

# 僅打包不安裝
npm run pack
```

### 打包配置說明

在 `package.json` 中的 `build` 配置：

```json
{
  "files": [
    "src/**/*",           // 源代碼 -> resources/app/src/
    "node_modules/**/*",  // 依賴 -> resources/app/node_modules/
    "models/",            // 模型資料夾 -> resources/app/models/
    "models/README.md",   // 說明檔案
    "!models/*.gguf"      // 排除 .gguf 檔案
  ],
  "extraFiles": [
    {
      "from": "bin",      // 二進位檔案 -> resources/bin/
      "to": "bin",
      "filter": ["**/*"]
    }
  ]
}
```

### 重要注意事項

1. **bin 資料夾位置**
   - 開發環境：`./bin/`
   - 打包後：`resources/bin/`
   - 程式會自動處理路徑差異

2. **models 資料夾位置**
   - 開發環境：`./models/`
   - 打包後：`resources/app/models/`
   - 用戶需要將模型檔案放入此位置

2. **models 資料夾**
   - 打包時排除 `.gguf` 檔案
   - 僅包含 `README.md` 說明檔案
   - 用戶需要手動添加模型檔案

3. **平台相容性**
   - Windows: `.exe` 檔案
   - Linux/macOS: 無副檔名執行檔
   - 自動檢測平台並選擇正確的二進位檔案

### 除錯

如果遇到路徑問題：

1. **檢查 console 輸出**
   ```javascript
   console.log('App is packaged:', app.isPackaged);
   console.log('Resources path:', process.resourcesPath);
   console.log('App path:', app.getAppPath());
   ```

2. **驗證檔案存在**
   ```javascript
   const fs = require('fs');
   console.log('Binary exists:', fs.existsSync(binaryPath));
   console.log('Models dir exists:', fs.existsSync(modelsPath));
   ```

3. **常見問題**
   - 二進位檔案沒有執行權限（Linux/macOS）
   - 路徑包含特殊字元
   - 防火牆阻擋執行檔

### 發布檢查清單

打包前確認：
- [ ] 所有平台的二進位檔案都存在
- [ ] `package.json` 版本號已更新
- [ ] 測試開發模式正常運行
- [ ] 測試打包後應用程式正常運行
- [ ] 確認模型載入功能正常
- [ ] 確認網路節點發現功能正常