# 系統架構與模組代理 (AGENTS.md)

本專案採用 Electron 構建，透過 main process 與 renderer process 的 IPC 通訊來管理背景服務與 UI 狀態。以下是各模組的核心職責與相依性。

## 目錄結構

```text
llamacpp-distributed-inference/
├── src/
│   ├── main/                 # 系統核心服務層 (Main Process)
│   │   ├── index.js          # 應用程式入口、IPC 通訊管理、mDNS 節點發現、子進程管理
│   │   ├── hf-downloader.js  # [新] Hugging Face REST API 模型下載器 (支援分割 GGUF)
│   │   ├── updater.js        # [新] llama.cpp 核心二進位檔自動更新器 (解析 GitHub API)
│   │   └── utils.js          # [新] 路徑解析與共用網路工具
│   ├── preload/              # 隔離層 (Preload)
│   │   └── index.js          # 安全暴露 electronAPI 給前端
│   └── renderer/             # 使用者介面層 (Renderer Process)
│       ├── index.html        # 儀表板視圖
│       ├── app.js            # 介面邏輯、狀態綁定、模態框控制
│       └── styles.css        # 元件與主題樣式
├── .github/workflows/        # CI/CD 管道
│   ├── build.yml             # 自動建置與封裝 (抓取 ggml-org 二進位檔)
│   └── download-binaries.yml # 二進位檔更新腳本
└── package.json              # 專案依賴與腳本
```

## 核心模組職責

### 1. `src/main/index.js` (The Controller)
- **職責**：應用程式大腦。負責啟動/關閉 `llama-server` (API) 和 `rpc-server` (運算節點)。
- **設計決策**：透過 `bonjour-service` 實現 mDNS 零設定網路發現，並維護統一的 `discoveredNodes` 清單，避免重複邏輯。

### 2. `src/main/hf-downloader.js` (The Model Fetcher)
- **職責**：無縫下載模型。
- **設計決策**：棄用厚重的 Python 依賴，直接呼叫 Hugging Face 的 `/api/models/{repo}/revision/main` API。並使用正規表達式解析 `-00001-of-00005.gguf` 分片，自動分組量化變體並排程批次下載。

### 3. `src/main/updater.js` (The Core Maintainer)
- **職責**：確保推理引擎處於最新狀態。
- **設計決策**：直接從 `ggml-org/llama.cpp` 的 GitHub Release 下載 `.zip` (Windows) 或 `.tar.gz` (Unix)，解壓縮並覆蓋至本地 `/bin` 目錄。Windows 平台上會自動下載並配對相應的 `cudart` 動態連結庫，保證 CUDA 環境完整性。

### 4. `src/renderer/app.js` (The Interface)
- **職責**：將使用者操作對映至背景行為。
- **設計決策**：在設定面板新增推測解碼 (Speculative Decoding) 開關與參數，將選取的主模型與 Draft 模型狀態同步至 IPC 呼叫。

## 關鍵資料流向

1. **推測解碼 (Speculative Decoding)**:
   - 用戶 UI 選擇 Draft 模型 -> `app.js` 蒐集 `draftModel`, `draftMin` 等參數 -> `ipcRenderer` 發送 `start-api-server` -> `index.js` 將其轉換為 `-md`, `--draft-min` 附加至 `llama-server` spawn 參數。

2. **GGUF 下載**:
   - UI 輸入 Repo ID -> `hf-downloader.js` 查詢 HF API 並按變體（如 Q4_K_M）分組 -> UI 勾選變體 -> 觸發迴圈循序下載檔案（若為分割檔則批次下載），實時更新進度條。

## 外部服務相依
- **Hugging Face API**: `https://huggingface.co/api/models`
- **GitHub Release API**: `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`
