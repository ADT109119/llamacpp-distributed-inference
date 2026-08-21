# Tauri 重構設計方案

日期：2026-08-22
狀態：已審閱（brainstorming 流程）
分支：`tauri-refactor`

## 1. 背景與目標

現行專案為 Electron（Node.js）桌面應用：`src/main/*` 約 2800 行 Node.js 核心邏輯，`src/renderer/*` 約 2700 行純 HTML/CSS/JS 前端。目標：

1. 以 **Tauri v2 + Rust** 重寫核心，捨棄 Node.js 相依。
2. 提供 **CLI** 完整控制能力：`llama-dist <子命令>`。
3. 提供 **常駐功能匣**（系統匣圖示）：關閉視窗收進圖示，RPC/API 服務持續運行，選單可控制服務。
4. 目標平台 **Windows 優先**，macOS/Linux 標記 best-effort，CI 只跑 Windows 建置。

## 2. 已確認的決策

| 決策點 | 結論 |
|---|---|
| 核心架構 | 全 Rust 重寫（無 Node sidecar），Tauri GUI 與 CLI 共用同一套 core crate |
| CLI 定位 | 完整控制 CLI：透過本地控制接口操作已啟動的常駐實例，亦可直接 daemon headless 模式 |
| 常駐行為 | 關閉主視窗 → 收進功能匣，RPC/API 服務持續運行；選單快速控制；退出時清理子進程 |
| 前端 | 保留現有原生 HTML/CSS/JS，僅以 `bridge.js` 以 Tauri globals 模擬 `electronAPI`，`app.js` 零改動 |
| 平台 | Windows 優先；macOS/Linux best-effort |

## 3. 資料流總覽

```
┌───────────── GUI (Tauri) ─────────────┐      ┌───────────── CLI ─────────────────┐
│ TauriWindow → #[tauri::command] 薄包裝  │      │ clap 子命令                         │
│ subscribe<CoreEvent> → emit 前端事件    │      │ HTTP + token → 127.0.0.1:59999     │
└───────────────┬───────────────────────┘      │ (無實例時可 headless 直接跑 daemon)   │
               ▼                              │                                      │
        ┌───────────────────────────────────────────────────────────────┐
        │                  llama-dist-core (純 Rust, 零 Tauri 相依)      │
        │  AppState{ rpc, proxy, backend, mdns, nodes, config, ... }    │
        │  事件匯流排: broadcast<CoreEvent>                               │
        ├──────────────────────────────────────────────────────────────┤
        │ mdns.rs · nodes.rs · models.rs · rpc.rs · backend.rs          │
        │ proxy.rs (axum :8080) · hf.rs · updater.rs · control.rs       │
        └───────┬──────────────────────────┬───────────────────────────┘
                ▼ spawn                    ▼ HTTP
        rpc-server.exe              llama-server.exe (backend :8081+)
        (端口 50052)                (動態模型載入、/health 就緒)
```

執行模式（單一可執行檔 `llama-dist`）：

- `llama-dist`（無參數）→ GUI 模式（Tauri 視窗 + 功能匣）
- `llama-dist daemon` → headless 常駐（無視窗，開啟 RPC + mDNS + control 伺服器；`--rpc-only` / `--no-mdns` 旗標可選）
- `llama-dist <其餘子命令>` → 本地控制：讀 `control.json` token 呼叫本地 control 伺服器；無實例時明確報錯

## 4. Cargo Workspace 結構

```
llamacpp-distributed-inference/
├── Cargo.toml                    # workspace: members = ["crates/core", "crates/app"]
├── crates/
│   ├── core/
│   │   ├── src/
│   │   │   ├── lib.rs            # re-export、CoreEvent 定義
│   │   │   ├── state.rs          # AppState 建構與共享（Arc<TokioMutex<_>>），事件訂閱
│   │   │   ├── config.rs         # JSON 設定檔：%APPDATA%\llama-dist\config.json
│   │   │   ├── paths.rs          # bin/ 解析（portable: exe 目錄下 bin；dev: 專案根）、models/ 路徑
│   │   │   ├── rpc.rs            # rpc-server 進程管理（啟動/停止/重啟/退出）
│   │   │   ├── backend.rs        # llama-server 後端進程、args 組裝、/health 等待（60s）
│   │   │   ├── proxy.rs          # axum :8080 代理 + 動態模型載入 + 記憶體檢查 + 閒置卸載
│   │   │   ├── mdns.rs           # mdns-sd：publish + 30s 定時 browse、_llm-cluster._tcp
│   │   │   ├── nodes.rs          # 節點過濾（IPv4 驗證、本機映射 127.0.0.1）、手動節點、TCP 檢查
│   │   │   ├── models.rs         # GGUF 掃描、路徑設定/重置、模型匹配規則、記憶體評估
│   │   │   ├── hf.rs             # HF API（searchRepo/listGGUFFiles）+ 分片下載 + 進度/取消
│   │   │   ├── updater.rs        # GitHub Release：checkForUpdates/assets/downloadAndInstall（zip/tar.gz + cudart）
│   │   │   └── control.rs        # 本地控制 HTTP 伺服器（axum, 127.0.0.1:59999, token 驗證, SSE logs）
│   │   └── tests/                # 純邏輯單測
│   └── app/
│       ├── src/
│       │   ├── main.rs           # clap 解析：無參數=GUI，daemon=常駐，其餘=CLI 客戶端
│       │   ├── tauri_app.rs      # setup：建立 AppState、tray、single-instance、commands
│       │   ├── commands.rs       # ~25 個 #[tauri::command]
│       │   ├── cli.rs            # CLI 客戶端（HTTP → control 伺服器）
│       │   └── daemon.rs         # headless 常駐（tokio 主循環）
│       └── tauri.conf.json
├── frontend/                     # 由 src/renderer 搬移
│   ├── index.html                # 僅追加 <script src="bridge.js">
│   ├── bridge.js                 # [新] window.electronAPI shim
│   ├── app.js                    # 零改動
│   └── styles.css                # 零改動
├── bin/  model images/  scripts/ # 維持原樣（llama.cpp 二進位、模型、圖示）
├── .github/workflows/build.yml   # 改為 tauri CLI / cargo 建置，Windows 優先
└── src/                          # Electron 舊代碼於最終 PR 移除（開發期保留對照）
```

## 5. core crate 規格

### 5.1 事件匯流排（`lib.rs`）

```rust
pub enum CoreEvent {
    NodeUpdate(Vec<String>),
    RpcServerStatus(bool),
    RpcServerLog(String),
    RpcServerError(String),
    ApiServerStatus(ApiStatus),      // { running, message, loaded_model }
    ApiServerLog(String),
    ApiServerError(String),
    DownloadProgress(DownloadProgress), // { percent, message, current_file, type: llamacpp|hf }
    Log(Subsystem, String),           // 系統日誌（node/sys）
}
```

`AppState` 持有 `tokio::sync::broadcast::Sender<CoreEvent>`。GUI 訂閱後 re-emit 為同名的 Tauri 事件；daemon 訂閱後寫 tracing 日誌（CLI `logs -f` 經 control 伺服器 SSE 暴露）。事件名與現有前端監聽名一一对應（bridge.js 層做 snake_case mapping）。

### 5.2 RPC 伺服器（`rpc.rs`）

- 啟動參數：`rpc-server [-H 0.0.0.0 -p 50052 -c]`（與現有一致）
- 版本為「未安裝」時跳過自動啟動（對齊現行 `startRpcServer` 邏輯）
- tokio 子進程：stdout/stderr 行化 → `RpcServerLog/Log` 事件
- 退出時 kill 所有子進程

### 5.3 後端與代理（`backend.rs`、`proxy.rs`）

照搬現行代理行為（`src/main/index.js:576-831`）：

- 代理 `0.0.0.0:8080` → backend `127.0.0.1:{動態端口}`（8081 起找空閒）
- 請求解析 JSON body 的 `model` 欄位 → 依四級匹配規則（精確/無副檔名/大小寫/子字串）找 GGUF
- 配置規則（HTTP 碼與 code 對齊現行）：`restrictSingleModel` 違規（400, `model_switching_restricted`）、`autoLoadEnabled=false`（400, `auto_load_disabled`）、`maxMemoryLimit` GB 超標（400, `memory_limit_exceeded`）、請求模型無法匹配（404, `model_not_found`）、無 backend 且無法載入（503, `no_active_model`）
- 記憶體檢查：模型大小 vs `totalMem - 1GB`（拒絕）、vs 剩餘+當前模型大小（警告日誌）、+512MB 緩衝
- backend 啟動參數組裝與現行 `loadModelBackend` 完全一致：`-m --host --port [--api-key] [--rpc ip:50052,...] [-ngl] [-np] [--ctx-size] [-fa] [-ctk] [-ctv] [-t] [--device]` + 推測解碼 `-md -ngld --draft-max --draft-min --draft-p-min`
- 啟動後輪詢 `/health`（500ms 間隔，60s 超時）
- 閒置卸載：可設 `idleTimeout` 分鐘，無請求則 kill backend（代理持續運行）
- 模型切換：先 kill 舊 backend、等 1s 再啟動新模型

### 5.4 mDNS（`mdns.rs`、`nodes.rs`）

- `mdns-sd` 發布：`name=LLMNode-{hostname}`、`_llm-cluster._tcp`、port 50052、TXT {version, platform}
- browse 常駐 + 每 30s 短暫 browse（5s window，對齊現行）
- 節點過濾規則（逐行對齊 `filterAndAddNode`）：空值跳過、`0.0.0.0` 跳過、`169.254.*` 跳過、含 `:` 跳過、IPv4 正規表達式驗證、本機地址映射為 `127.0.0.1`
- `down` 事件移除節點；手動添加（`add_manual_node`）含 IP 驗證、本機地址拒絕、TCP 50052 連接檢查（5s 超時）

### 5.5 模型（`models.rs`、`config.rs`、`paths.rs`）

- 預設路徑：portable 時 exe 目錄 `models/`；dev 時 cwd 的 `models/`；可透過 config 覆蓋
- 首次建立 models 目錄時寫入 README.md（與現有內容一致）
- config 檔 schema（對齊 electron-store 現有 key）：

```json
{ "modelsPath": "", "apiKey": "", "theme": "light", "serverOptions": { ... } }
```

（`serverOptions` 持久化最後一次啟動參數，供 CLI `api start` 與功能匣「啟動 API（上次配置）」使用；現有版本每次重開會失掉配置，此為輕度增強。）

### 5.6 Hugging Face（`hf.rs`）

- `GET /api/models/{repo}/revision/main`（repo 資訊）、`GET /api/models/{repo}/tree/main`（GGUF 清單）
- 分片解析：`-00001-of-00005.gguf` 正規表達式 → 按量化變體分組
- 下載：reqwest 流式、Content-Length 進度、`.part` 暫存檔 → rename；`AtomicBool` 取消
- 重試：網路失敗 3 次（指數退避）；分片下載失敗保留已完部分並報錯

### 5.7 llama.cpp 更新器（`updater.rs`）

- GitHub Release API（`ggml-org/llama.cpp/releases/latest`）
- 資產選擇：Windows `.zip`（含 CUDA 資產）；非 Win `.tar.gz`
- 下載 → 解壓（zip crate / flate2 + tar）→ 覆蓋 `bin/{platform}/`
- Windows 下載並配對 `cudart64_*.dll`（邏輯對齊 `src/main/updater.js`）
- 進度：`download-progress` 事件（percent, message, type=llamacpp）
- 更新前需先停止 RPC/API（由 CLI command 層調用 `AppState::stop_all_servers` 後再執行）

### 5.8 本地控制伺服器（`control.rs`）

- `127.0.0.1:59999`（被佔用時嘗試 +1，最多 10 次；實際端口寫入 control.json）
- 認證：每次啟動產生隨機 token（32B hex），寫入 `control.json`：

```json
{ "port": 59999, "token": "…", "pid": 1234, "mode": "gui|daemon", "started_at": "…" }
```

  路徑：`%LOCALAPPDATA%\llama-dist\control.json`（Unix：`$XDG_RUNTIME_DIR`/`$HOME/.local/llama-dist`）
- 端點（全部需 `?token=` 或 `Authorization: Bearer`）：

| 端點 | 對齊 IPC |
|---|---|
| `GET /status` | 整體狀態（rpc/api/nodes/版本/配置摘要） |
| `POST /rpc/{start,stop,restart}` | restart-rpc-server |
| `POST /api/start` `POST /api/stop` `POST /model/unload` | start-api-server / stop-api-server / unload-model |
| `GET/POST /nodes` `DELETE /nodes/{ip}` `POST /nodes/check` | 節點四件套 |
| `GET /models` `GET/POST /models/path` | 模型清單/路徑 |
| `GET /logs?stream=rpc\|api\|system`（SSE） | 事件訂閱 |
| `POST /hf/search` `POST /hf/models` `POST /hf/download` `POST /hf/cancel` | HF 四件套 |
| `GET /core/version` `POST /core/check-update` `GET /core/assets` `POST /core/update` | 更新器四件套 |
| `GET /config` `POST /config` | 配置 |
| `POST /quit` | 退出（停止所有進程後退出） |

- 無實例時 control 伺服器不存在 → CLI 收到連接拒絕/404 時輸出「未在運行，請先執行 llama-dist 或 llama-dist daemon」

## 6. GUI 層（`crates/app` + Tauri v2）

- **capabilities 與 plugins**（`tauri.conf.json` / `capabilities/`）：
  - `tauri-plugin-single-instance`：重複啟動聚焦已有視窗
  - `tauri-plugin-autostart`：功能匣選單「隨系統啟動」（checkable）
  - `tauri-plugin-dialog`：選擇模型資料夾（在 `browse_models_folder` command 內用）
  - `tauri-plugin-opener`：開啟資料夾
  - `tauri-plugin-shell`：開啟外部連結（HF/GitHub 頁面）
- **功能匣**（tray）選單：
  1. 顯示/隱藏主視窗
  2. （sep）RPC：啟動 / 停止 / 重啟
  3. （sep）API：啟動（上次配置）/ 停止
  4. （sep）模型：重新掃描 / 開啟資料夾
  5. （sep）llama.cpp：檢查更新
  6. （sep）隨系統啟動（checkable）
  7. （sep）**退出**（kill 子進程、關 mDNS、釋放資源）
- **視窗行為**：關閉視窗 → 隱藏（不退出，服務持續）；退出只從功能匣。macOS 的 dock activate 行為：activate 時重建視窗（對齊 `app.on('activate')`）
- **commands**：~25 個，簽名與現有 IPC 對齊（參數蛇化）。返回值統一 `{ success, message, ... }` 結構（對齊現有前端解構）
- **橋接**：setup 時把 `broadcast::Receiver<CoreEvent>` 訂閱 → `app.emit(eventName, payload)`，事件名（8 個，與現有前端監聽一一对應）：`node-update`、`rpc-server-status`、`rpc-server-log`、`rpc-server-error`、`api-server-status`、`api-server-log`、`api-server-error`、`download-progress`

## 7. frontend/bridge.js（唯一的Renderer 改動）

```js
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const listeners = new Map(); // channel -> [unlisten, cb]
  const api = {
    getModels: () => invoke('get_models'),
    // … 25 個方法，invoke 名映射：get-models -> get_models 等
    onNodeUpdate: (cb) => listen('node-update', (e) => cb(e.payload)),
    // … 其餘事件
    removeAllListeners: (ch) => { (listeners.get(ch) || []).forEach(({ unlisten }) => unlisten()); listeners.delete(ch); }
  };
  window.electronAPI = api;
})();
```

（`index.html` 僅在 app.js 之前追加此 script。app.js / styles.css / 其餘 html 零改動。）

## 8. CLI 規格

```
llama-dist                          # GUI
llama-dist daemon [--rpc-only] [--no-mdns] [--port 59999]
llama-dist status [--json]
llama-dist rpc start | stop | restart
llama-dist api start [--model M] [--ngl N] [--np N] [--ctx N] [--rpc ip1,ip2] [--no-auto-load]
llama-dist api stop
llama-dist model list | unload
llama-dist nodes list | add <ip> | remove <ip> | check <ip>
llama-dist models list | path [PATH]
llama-dist logs <system|rpc|api> [-f] [--lines N]
llama-dist hf search <repo> | models <repo> | download <repo> [--variant V] [--file F] | cancel
llama-dist core version | check-update | update [--asset NAME]
llama-dist config get [key] | set key value
llama-dist quit
```

- 預設人類可讀輸出；`--json`（或 `status --json`）機器可讀
- 連線失敗時的錯誤訊息明確：「control 伺服器不可達（未在運行？）→ 提示 `llama-dist` 或 `llama-dist daemon`」
- `daemon` 為前台進程（背景執行交給 OS 服務/快捷方式）；重覆執行 daemon 時若 control.json 已有活性實例 → 拒絕並提示
- 實例活性檢查：control.json 的 pid + HTTP ping 雙重驗證（防 stale）

## 9. 打包與 CI

- **Tauri bundle**（Windows）：NSIS 安裝包（主）+ portable（zip）。AppId 維持 `com.the-walking-fish.distributed-llm`
- `bin/`（llama.cpp 二進位）**預設捆進 bundle**（NSIS extraResources + portable 同梱資料夾，對齊現行 Electron `extraFiles`）；更新器隨時可線上下載新版覆蓋。CI 階段先下載 ggml-org 二進位再打包（對齊現有 build.yml 邏輯）
- `models/` 空目錄 + README 由程式自動建立（不捆模板）
- **CI（.github/workflows/build.yml 重寫）**：
  - 觸發：push tag / workflow_dispatch
  - Windows (windows-latest)：安裝 Rust + Tauri 前置 → `cargo tauri build --bundles nsis,portable` → 附 `bin/windows/*` 已下載 → Releases 上傳
  - macOS/Linux job 標記 `continue-on-error: true`（best-effort，預設不阻塞）
  - `download-binaries` 腳本改寫為 Rust 小工具或 PowerShell（CI 階段用，非 runtime 相依）

## 10. 遷移策略（分阶段）

| 階段 | 內容 | 完成標準 |
|---|---|---|
| 0 | workspace 骨幹、paths/config/state/事件匯流排 | `cargo test` 綠 |
| 1 | core：rpc + backend + proxy（無 mDNS 亦可運作，手動節點） | 本地手動驗證：proxy 代理 + 模型載入 |
| 2 | core：mdns + nodes + models | 雙端節點發現冒煙（或單端 + 手動節點） |
| 3 | core：hf + updater | 下載 Q4_K_M 小模型驗證進度/取消 |
| 4 | core：control 伺服器 | curl 全端點通過 |
| 5 | app：GUI（commands/bridge/tray/single-instance/autostart） | `tauri dev` 對照 Electron 版功能清單 |
| 6 | app：CLI + daemon | 全子命令對照 |
| 7 | 打包 + CI + 文件（README/DEVELOPMENT/AGENTS.md 更新） | NSIS 安裝後全流程可操作 |
| 8 | 移除 Electron 殘留（src/、package.json、舊 scripts） | main 合併 |

Electron 舊代碼於階段 8 之前均保留在 worktree 供對照。

## 11. 測試策略

**單元（純邏輯，無網路）**：
- `nodes`：IPv4 驗證、本機映射、169.254 過濾
- `models`：四級匹配規則、README 建立
- `backend`：args 組裝（各參數組合快照）
- `hf`：分片正規表達式（`-00001-of-00005.gguf`）、變體分組
- `updater`：資產名稱過濾（win-cuda / win-cpu / mac / linux 資產選擇）
- `control`：token 驗證 401/200

**對照清單（手動）**：25 個 IPC handler 逐一對照輸入/輸出/錯誤訊息格式。

**不在範圍**：多端分佈式推理效能測試（與現行相同，不在本重構範圍）。

## 12. 風險與對策

| 風險 | 對策 |
|---|---|
| `mdns-sd` 在 Windows 多網卡/link-local 行為差異 | 過濾規則已對齊；保留手動添加；冒煙測試 |
| 單 exe 混 Tauri/clap 參數衝突 | clap 以 `allow_external_subcommands=false`，無參數才進 Tauri；Tauri 不消費未知參數 |
| webview2 對現有原生 JS 的相容性 | 純標準瀏覽器 API；`tauri dev` 早期中期驗證 |
| 長下載（HF/GitHub）的超時與斷線 | reqwest 無超時（transfer）+ 重試 + `.part` 續傳（v1 不實作續傳，失敗重下該檔） |
| 更新時二進位檔被鎖 | 更新前 `stop_all_servers`（對齊現行）；NSIS 升級時建議先退出（installer 訊息提示） |
| control.json stale（異常退出） | pid 檢查 + HTTP ping，stale 時 CLI 提示可安全忽略 |

## 13. 非目標（明確排除）

- 多語言本地化（維持繁中）
- 雲端/公網部署（維持內網定位）
- 模型續傳/斷點重傳（v1 失敗重下單檔）
- macOS/Linux CI 正式建置（best-effort only）
- Electron 舊版相容（階段 8 移除）
