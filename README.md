# 分佈式 LLM 推理桌面應用程式

一個基於 Electron 的跨平台桌面應用程式，讓您能夠利用區域網路內的多台電腦協同進行大型語言模型的分佈式推理。

## 功能特色

- 🖥️ **圖形化介面**: 直觀的桌面應用程式介面
- 🌐 **自動節點發現**: 自動偵測區域網路內的其他節點
- ⚡ **分佈式推理**: 將模型計算分散到多個節點
- 📁 **模型管理**: 輕鬆載入和管理 GGUF 格式模型
- 🔒 **API 安全**: 支援 API Key 保護
- 📊 **即時監控**: 查看伺服器狀態和日誌
- 🚀 **跨平台**: 支援 Windows、macOS 和 Linux

## 系統需求

- Node.js 18+ 
- 支援的作業系統：Windows 10+、macOS 10.15+、Ubuntu 18.04+
- 至少 8GB RAM（取決於模型大小）
- 可選：NVIDIA GPU（用於 GPU 加速）

## 安裝步驟

### 開發環境

1. **克隆專案**
   ```bash
   git clone <repository-url>
   cd distributed-llm-inference
   ```

2. **安裝依賴**
   ```bash
   npm install
   ```

3. **準備模型檔案**
   - 將 `.gguf` 格式的模型檔案放入 `models/` 資料夾
   - 可從 [Hugging Face](https://huggingface.co/models?library=gguf) 下載

4. **確認二進位檔案**
   - 確保 `bin/` 資料夾包含對應平台的執行檔
   - Windows: `rpc-server.exe`, `llama-server.exe`
   - Linux/macOS: `rpc-server`, `llama-server`

### 生產環境（打包後）

打包後的應用程式結構：
```
app/
├── resources/
│   ├── bin/               # llama.cpp 執行檔
│   │   ├── windows/
│   │   ├── linux/
│   │   └── macos/
│   └── app/
│       ├── src/
│       ├── models/        # 模型資料夾（僅包含 README.md）
│       └── node_modules/
```

**重要說明**：
- 打包時會自動排除 `.gguf` 檔案以減少安裝包大小
- 用戶需要手動將模型檔案放入安裝後的 `models/` 資料夾
- 應用程式會自動檢測並載入 `models/` 資料夾中的 `.gguf` 檔案

## 使用方法

### 開發模式
```bash
npm run dev
```

### 生產模式
```bash
npm start
```

### 打包應用程式
```bash
npm run build
```

## 使用說明

1. **啟動應用程式**
   - 應用程式會自動啟動 RPC 伺服器作為計算節點

2. **節點發現**
   - 應用程式會自動發現區域網路內的其他節點
   - 在節點列表中選擇要參與計算的節點

3. **載入模型**
   - 從下拉選單選擇要使用的模型
   - 設定 GPU 層數（如果有 GPU）

4. **設定 API Key**（可選）
   - 點擊「設定 API Key」按鈕
   - 輸入 API Key 以保護您的服務

5. **啟動推理服務**
   - 點擊「啟動 API 伺服器」
   - 服務將在 `http://localhost:8080` 啟動

6. **使用 API**
   ```bash
   curl -X POST http://localhost:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -d '{
       "model": "gpt-3.5-turbo",
       "messages": [{"role": "user", "content": "Hello!"}]
     }'
   ```

## 網路設定

### 防火牆設定
確保以下端口開放：
- **50052**: RPC 伺服器通訊端口
- **8080**: API 伺服器端口
- **5353**: mDNS 服務發現端口

### 區域網路需求
- 所有節點必須在同一個區域網路內
- 支援 mDNS 廣播（大部分家用路由器都支援）

## 故障排除

### 常見問題

1. **找不到節點**
   - 檢查防火牆設定
   - 確保所有設備在同一網路
   - 確認 mDNS 服務正常運作

2. **模型載入失敗**
   - 檢查模型檔案格式是否為 `.gguf`
   - 確認檔案沒有損壞
   - 檢查磁碟空間是否足夠

3. **API 伺服器啟動失敗**
   - 檢查端口 8080 是否被佔用
   - 確認模型檔案存在
   - 查看系統日誌獲取詳細錯誤訊息

4. **記憶體不足**
   - 選擇較小的模型
   - 減少 GPU 層數
   - 增加更多計算節點分散負載

### 日誌查看
應用程式提供三種日誌：
- **系統日誌**: 應用程式狀態和操作記錄
- **RPC 日誌**: RPC 伺服器運行日誌
- **API 日誌**: API 伺服器運行日誌

## 技術架構

- **前端**: HTML + CSS + JavaScript
- **後端**: Electron (Node.js)
- **推理引擎**: llama.cpp
- **服務發現**: mDNS (bonjour-service)
- **設定儲存**: electron-store

## 開發

### 專案結構
```
├── src/
│   ├── main/           # Electron 主進程
│   ├── preload/        # 預載腳本
│   └── renderer/       # 前端介面
├── bin/                # llama.cpp 二進位檔
├── models/             # 模型檔案
└── package.json
```

### 貢獻指南
1. Fork 專案
2. 創建功能分支
3. 提交變更
4. 發送 Pull Request

## 授權

MIT License

## 支援

如有問題或建議，請提交 Issue 或聯繫開發團隊。