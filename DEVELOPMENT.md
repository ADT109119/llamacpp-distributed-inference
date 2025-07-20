# 開發指南

## 專案架構

```
distributed-llm-inference/
├── src/
│   ├── main/           # Electron 主進程
│   │   ├── index.js    # 主進程入口點
│   │   └── utils.js    # 工具函數
│   ├── preload/        # 預載腳本
│   │   └── index.js    # IPC 橋樑
│   └── renderer/       # 渲染進程（前端）
│       ├── index.html  # 主頁面
│       ├── styles.css  # 樣式表
│       └── app.js      # 前端邏輯
├── bin/                # llama.cpp 二進位檔
│   ├── windows/        # Windows 執行檔
│   ├── linux/          # Linux 執行檔
│   └── macos/          # macOS 執行檔
├── models/             # 模型檔案目錄
├── package.json        # 專案配置
├── README.md           # 使用說明
├── start.bat           # Windows 啟動腳本
└── start.sh            # Linux/macOS 啟動腳本
```

## 開發環境設定

### 1. 安裝 Node.js
- 下載並安裝 [Node.js](https://nodejs.org/) (建議 LTS 版本)
- 確認安裝：`node --version` 和 `npm --version`

### 2. 安裝專案依賴
```bash
npm install
```

### 3. 準備二進位檔案
確保 `bin/` 目錄包含對應平台的 llama.cpp 執行檔：
- `rpc-server` / `rpc-server.exe`
- `llama-server` / `llama-server.exe`

### 4. 準備模型檔案
將 `.gguf` 格式的模型檔案放入 `models/` 目錄。

## 開發命令

### 啟動開發模式
```bash
npm run dev
```
這會啟動 Electron 並開啟開發者工具。

### 啟動生產模式
```bash
npm start
```

### 打包應用程式
```bash
npm run build
```

## 核心功能實現

### 1. 主進程 (src/main/index.js)
- **RPC 伺服器管理**: 自動啟動和管理 `rpc-server` 子進程
- **mDNS 服務發現**: 使用 `bonjour-service` 進行節點發現
- **API 伺服器控制**: 管理 `llama-server` 的啟動和停止
- **IPC 處理**: 處理來自渲染進程的請求

### 2. 預載腳本 (src/preload/index.js)
- **安全橋樑**: 在主進程和渲染進程間提供安全的通訊介面
- **API 暴露**: 將主進程功能安全地暴露給前端

### 3. 渲染進程 (src/renderer/)
- **使用者介面**: 提供直觀的圖形化操作介面
- **狀態管理**: 管理應用程式的各種狀態
- **事件處理**: 處理使用者操作和系統事件

## 關鍵技術點

### mDNS 服務發現
```javascript
// 發布服務
bonjour.publish({ 
  name: 'LLMNode-' + hostname, 
  type: 'llm-cluster', 
  port: 50052 
});

// 發現服務
const browser = bonjour.find({ type: 'llm-cluster' });
browser.on('up', (service) => {
  // 處理發現的節點
});
```

### 子進程管理
```javascript
// 啟動 RPC 伺服器
rpcServerProcess = spawn(rpcServerPath, ['-H', '0.0.0.0', '-p', '50052', '-c']);

// 監聽輸出
rpcServerProcess.stdout.on('data', (data) => {
  console.log(`rpc-server: ${data}`);
});

// 清理進程
app.on('will-quit', () => {
  if (rpcServerProcess) {
    rpcServerProcess.kill();
  }
});
```

### IPC 通訊
```javascript
// 主進程
ipcMain.handle('start-api-server', async (event, options) => {
  // 處理啟動 API 伺服器的邏輯
  return { success: true, message: '啟動成功' };
});

// 渲染進程
const result = await window.electronAPI.startApiServer(options);
```

## 除錯技巧

### 1. 開啟開發者工具
在開發模式下會自動開啟，或按 `Ctrl+Shift+I` (Windows/Linux) 或 `Cmd+Opt+I` (macOS)

### 2. 查看主進程日誌
主進程的 `console.log` 會顯示在終端中

### 3. 查看子進程輸出
RPC 和 API 伺服器的輸出會透過 IPC 發送到前端日誌區域

### 4. 網路除錯
- 檢查防火牆設定
- 使用 `nmap` 掃描端口：`nmap -p 50052,8080 localhost`
- 檢查 mDNS 服務：`dns-sd -B _llm-cluster._tcp`

## 常見問題

### Q: 找不到其他節點
A: 
1. 檢查防火牆是否阻擋端口 50052 和 5353
2. 確認所有設備在同一網路
3. 檢查路由器是否支援 mDNS

### Q: 模型載入失敗
A:
1. 確認模型檔案格式為 `.gguf`
2. 檢查檔案路徑和權限
3. 確認有足夠的記憶體

### Q: API 伺服器無法啟動
A:
1. 檢查端口 8080 是否被佔用
2. 確認二進位檔案存在且有執行權限
3. 查看系統日誌獲取詳細錯誤

## 貢獻指南

### 1. 程式碼風格
- 使用 ES6+ 語法
- 適當的註解和文檔
- 遵循現有的命名慣例

### 2. 提交流程
1. Fork 專案
2. 創建功能分支：`git checkout -b feature/new-feature`
3. 提交變更：`git commit -m "Add new feature"`
4. 推送分支：`git push origin feature/new-feature`
5. 創建 Pull Request

### 3. 測試
- 在多個平台測試功能
- 確保不破壞現有功能
- 添加適當的錯誤處理

## 部署和打包

### 使用 electron-builder
```bash
# 打包當前平台
npm run build

# 打包所有平台
npm run build -- --win --mac --linux
```

### 配置打包選項
在 `package.json` 的 `build` 區段配置：
```json
{
  "build": {
    "appId": "com.example.distributed-llm",
    "productName": "分佈式 LLM 推理器",
    "extraResources": [
      "bin/**/*",
      "models/**/*"
    ]
  }
}
```

## 效能優化

### 1. 記憶體管理
- 監控子進程記憶體使用
- 適當設定模型參數
- 使用量化模型減少記憶體需求

### 2. 網路優化
- 優化 RPC 通訊參數
- 實現連線池管理
- 添加重連機制

### 3. 使用者體驗
- 添加載入指示器
- 實現漸進式載入
- 優化介面響應速度