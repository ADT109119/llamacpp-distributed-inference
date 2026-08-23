# Tauri 重構 Phase 0-1：Workspace 骨幹 + 核心進程管理與代理 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Cargo workspace 與 `llama-dist-core` crate，完成路徑/設定/事件匯流排，以及 rpc-server 進程管理、llama-server backend 管理（含模型匹配與記憶體檢查）和 axum API 代理，對齊現行 Electron 版行為。

**Architecture:** 純 Rust core crate（零 Tauri 相依），以 `tokio` 子進程管理 llama.cpp 二進位檔，以 `tokio::sync::broadcast` 作為事件匯流排（GUI/daemon 於後續階段訂閱）。代理邏輯抽出純函式決策層以便單元測試。工作目錄為 worktree：`.worktrees/tauri-refactor`。

**Tech Stack:** Rust 2021 edition, tokio, axum, serde/serde_json, thiserror, tempfile（dev）。

**設計文件:** `docs/superpowers/specs/2026-08-22-tauri-refactor-design.md`

**對照來源:** Electron 版 `src/main/index.js`（本計畫所有行為規則的單一事實來源）

---

## 前置需求

- 已安裝 Rust toolchain（`rustc --version` 可執行）
- 所有命令在 worktree 目錄執行：`E:\AI\llamacpp-distributed-inference\.worktrees\tauri-refactor`
- 分支：`tauri-refactor`

## 檔案結構總覽

```
Cargo.toml                      # workspace 根
crates/core/
├── Cargo.toml
├── src/
│   ├── lib.rs                  # CoreEvent、Subsystem、re-export
│   ├── error.rs                # ApiError（代理 HTTP 錯誤結構）
│   ├── paths.rs                # 平台識別、bin/models 路徑解析
│   ├── config.rs               # Config、ServerOptions（JSON 讀寫）
│   ├── state.rs                # CoreState（事件匯流排 + 共享狀態容器）
│   ├── models.rs               # GGUF 掃描、四級匹配、記憶體評估（純函式）
│   ├── process.rs              # 子進程輸出行化共用工具
│   ├── rpc.rs                  # RpcManager
│   ├── backend.rs              # BackendManager（args 組裝、spawn、health 等待）
│   └── proxy.rs                # ProxyServer（axum :8080）+ 切換決策純函式
└── tests/
    └── integration.rs          # 跨模組整合測試（config ↔ paths）
```

---

### Task 1: Workspace 與 core crate 骨幹

**Files:**
- Create: `Cargo.toml`
- Create: `crates/core/Cargo.toml`
- Create: `crates/core/src/lib.rs`
- Modify: `.gitignore`

- [ ] **Step 1: 建立 workspace 根 Cargo.toml**

```toml
[workspace]
resolver = "2"
members = ["crates/core"]

[workspace.package]
version = "2.0.0"
edition = "2021"
license = "Apache-2.0"

[profile.release]
strip = true
lto = true
```

- [ ] **Step 2: 建立 crates/core/Cargo.toml**

```toml
[package]
name = "llama-dist-core"
description = "分佈式 LLM 推理器核心（零 Tauri 相依）"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
tokio = { version = "1", features = ["full"] }
axum = "0.7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
tracing = "0.1"

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: 建立 crates/core/src/lib.rs（僅 enum，模組宣告由後續 Task 逐步加入）**

```rust
/// 系統日誌子系統
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subsystem {
    Node,
    Sys,
}

/// 核心事件：GUI / daemon / control 伺服器共用的唯一事件來源
#[derive(Debug, Clone)]
pub enum CoreEvent {
    NodeUpdate(Vec<String>),
    RpcServerStatus(bool),
    RpcServerLog(String),
    RpcServerError(String),
    ApiServerStatus {
        running: bool,
        message: String,
        loaded_model: Option<String>,
    },
    ApiServerLog(String),
    ApiServerError(String),
    DownloadProgress {
        percent: f64,
        message: String,
        current_file: String,
        kind: &'static str,
    },
}
```

（最終形態會包含 `pub mod config; pub mod error; pub mod models; pub mod paths; pub mod process; pub mod proxy; pub mod rpc; pub mod state;` 與 `pub use error::ApiError;` —— 由各 Task 的「lib.rs 加入模組宣告」步驟逐一補上。）

- [ ] **Step 4: 更新 .gitignore**

在 `.gitignore` 尾端追加：

```
# Rust
target/
```

- [ ] **Step 5: 驗證編譯**

Run: `cargo build`
Expected: `Finished` 無錯誤

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/core .gitignore
git commit -m "feat(core): 建立 Cargo workspace 與 llama-dist-core 骨幹、CoreEvent 定義"
```

---

### Task 2: paths.rs — 平台與二進位檔路徑解析

對照 `src/main/utils.js:16-65`。portable（打包後）：exe 同層找 `bin/<platform>/`；dev：從 `CARGO_MANIFEST_DIR` 往上找到專案根（含 `src/` 與 `bin/` 的那層）。用環境變數 `LLAMA_DIST_PORTABLE=exe_dir` 允許測試注入。

**Files:**
- Create: `crates/core/src/paths.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod paths;`）

- [ ] **Step 1: 寫失敗測試（附加在 paths.rs 底部）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_id() {
        if cfg!(windows) {
            assert_eq!(platform_id(), "windows");
        } else if cfg!(target_os = "macos") {
            assert_eq!(platform_id(), "macos");
        } else {
            assert_eq!(platform_id(), "linux");
        }
    }

    #[test]
    fn test_binary_name() {
        let name = binary_file_name("rpc-server");
        if cfg!(windows) {
            assert_eq!(name, "rpc-server.exe");
        } else {
            assert_eq!(name, "rpc-server");
        }
    }
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cargo test -p llama-dist-core paths`
Expected: FAIL（`paths` module 不存在或函式未定義）

- [ ] **Step 3: 實作 paths.rs**

```rust
use std::path::{Path, PathBuf};

/// 回傳平台識別符（對齊 utils.js getPlatformId）
pub fn platform_id() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 二進位檔完整檔名（Windows 加 .exe）
pub fn binary_file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// 專案根（開發模式）。以 CARGO_MANIFEST_DIR（crates/core）往上兩層。
fn dev_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("CARGO_MANIFEST_DIR 必須在專案的 crates/core 下")
}

/// 應用基礎路徑：
/// - 打包/portable 模式（偵測 exe 同層是否有 bin/ 或 models/）：exe 所在目錄
/// - 開發模式：專案根
pub fn base_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // portable 判斷：exe 目錄下存在 bin/（NSIS portable 佈局）
            if dir.join("bin").is_dir() && dir.file_name().is_some_and(|n| n != "deps") {
                return dir.to_path_buf();
            }
        }
    }
    dev_root()
}

/// bin/<platform>/ 目錄
pub fn bin_dir() -> PathBuf {
    base_path().join("bin").join(platform_id())
}

/// 二進位檔完整路徑
pub fn binary_path(name: &str) -> PathBuf {
    bin_dir().join(binary_file_name(name))
}

/// 二進位檔是否已安裝（以 llama-server 存在為準，取代 Electron 版版本字串檢查）
pub fn is_installed() -> bool {
    binary_path("llama-server").exists()
}

/// 模型資料夾預設路徑（未自訂時）：portable → exe 目錄/models；dev → cwd/models
/// （對齊 index.js getModelsPath）
pub fn default_models_path() -> PathBuf {
    if base_path() == dev_root() {
        std::env::current_dir()
            .unwrap_or_else(|_| dev_root())
            .join("models")
    } else {
        base_path().join("models")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_id() {
        if cfg!(windows) {
            assert_eq!(platform_id(), "windows");
        } else if cfg!(target_os = "macos") {
            assert_eq!(platform_id(), "macos");
        } else {
            assert_eq!(platform_id(), "linux");
        }
    }

    #[test]
    fn test_binary_name() {
        let name = binary_file_name("rpc-server");
        if cfg!(windows) {
            assert_eq!(name, "rpc-server.exe");
        } else {
            assert_eq!(name, "rpc-server");
        }
    }

    #[test]
    fn test_dev_base_path_contains_bin() {
        // 在開發環境下 base_path 應指到專案根（含 src/）
        let root = dev_root();
        assert!(root.join("src").exists() || root.join(".git").exists());
    }
}
```

- [ ] **Step 4: 在 lib.rs 加入模組宣告**

在 `lib.rs` 頂部加入：

```rust
pub mod paths;
```

- [ ] **Step 5: 執行測試確認通過**

Run: `cargo test -p llama-dist-core paths`
Expected: PASS（3 個測試）

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/paths.rs crates/core/src/lib.rs
git commit -m "feat(core): paths 模組 — 平台識別與 bin/models 路徑解析"
```

---

### Task 3: config.rs — Config 與 ServerOptions

對照 electron-store key（`modelsPath`, `apiKey`, `theme`）與前端 `startApiServer(options)` 的欄位（app.js:683-705）。serde 以 camelCase 序列化，與前端 JSON 直接相容。

**Files:**
- Create: `crates/core/src/config.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod config;`）

- [ ] **Step 1: 寫失敗測試（config.rs 內）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_server_options_camel_case_roundtrip() {
        let opts = ServerOptions {
            model_name: "qwen.gguf".into(),
            ctx_size: 4096,
            draft_p_min: 0.9,
            ..Default::default()
        };
        let json = serde_json::to_value(&opts).unwrap();
        assert_eq!(json["modelName"], "qwen.gguf");
        assert_eq!(json["ctxSize"], 4096);
        let back: ServerOptions = serde_json::from_value(json).unwrap();
        assert_eq!(back.model_name, "qwen.gguf");
    }

    #[test]
    fn test_config_default_and_roundtrip() {
        let cfg = Config::default();
        assert_eq!(cfg.theme, "light");
        let json = serde_json::to_string(&cfg).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme, "light");
    }

    #[test]
    fn test_load_missing_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = PathBuf::from(dir.path()).join("config.json");
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.theme, "light");
        assert!(cfg.models_path.is_empty());
    }

    #[test]
    fn test_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = PathBuf::from(dir.path()).join("config.json");
        let mut cfg = Config::default();
        cfg.api_key = "sk-test".into();
        cfg.save(&path).unwrap();
        let back = Config::load(&path).unwrap();
        assert_eq!(back.api_key, "sk-test");
    }
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cargo test -p llama-dist-core config`
Expected: FAIL

- [ ] **Step 3: 實作 config.rs**

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

fn default_theme() -> String {
    "light".into()
}

/// 啟動 API 伺服器的完整參數（欄位名對齊前端 app.js startApiServer payload）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerOptions {
    pub model_name: String,
    pub api_key: String,
    pub rpc_nodes: Vec<String>,
    pub ngl: u32,
    pub np: u32,
    pub ctx_size: u32,
    pub flash_attention: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub spec_enabled: bool,
    pub draft_model: String,
    pub draft_ngl: u32,
    pub draft_max: u32,
    pub draft_min: u32,
    pub draft_p_min: f64,
    /// 分鐘；0 = 停用
    pub idle_timeout: u32,
    pub auto_load_enabled: bool,
    /// GB；0 = 無限制
    pub max_memory_limit: u32,
    pub restrict_single_model: bool,
    pub cuda_device_id: String,
    pub cpu_threads: u32,
}

/// 應用設定（對齊 electron-store schema：modelsPath/apiKey/theme + serverOptions 增強）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub models_path: String,
    pub api_key: String,
    pub theme: String,
    pub server_options: Option<ServerOptions>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            models_path: String::new(),
            api_key: String::new(),
            theme: default_theme(),
            server_options: None,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> anyhow_result::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(_) => Ok(Self::default()),
        }
    }

    pub fn save(&self, path: &Path) -> anyhow_result::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text)?;
        Ok(())
    }
}

/// 內部別名，避免直接依賴 anyhow（此 crate 用簡單 Box<dyn Error> 即可）
mod anyhow_result {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_server_options_camel_case_roundtrip() {
        let opts = ServerOptions {
            model_name: "qwen.gguf".into(),
            ctx_size: 4096,
            draft_p_min: 0.9,
            ..Default::default()
        };
        let json = serde_json::to_value(&opts).unwrap();
        assert_eq!(json["modelName"], "qwen.gguf");
        assert_eq!(json["ctxSize"], 4096);
        let back: ServerOptions = serde_json::from_value(json).unwrap();
        assert_eq!(back.model_name, "qwen.gguf");
    }

    #[test]
    fn test_config_default_and_roundtrip() {
        let cfg = Config::default();
        assert_eq!(cfg.theme, "light");
        let json = serde_json::to_string(&cfg).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme, "light");
    }

    #[test]
    fn test_load_missing_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = PathBuf::from(dir.path()).join("config.json");
        let cfg = Config::load(&path).unwrap();
        assert_eq!(cfg.theme, "light");
        assert!(cfg.models_path.is_empty());
    }

    #[test]
    fn test_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = PathBuf::from(dir.path()).join("config.json");
        let mut cfg = Config::default();
        cfg.api_key = "sk-test".into();
        cfg.save(&path).unwrap();
        let back = Config::load(&path).unwrap();
        assert_eq!(back.api_key, "sk-test");
    }
}
```

- [ ] **Step 4: lib.rs 加入 `pub mod config;`**

- [ ] **Step 5: Run: `cargo test -p llama-dist-core config`**
  Expected: PASS（4 個測試）

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/config.rs crates/core/src/lib.rs
git commit -m "feat(core): config 模組 — Config/ServerOptions JSON 讀寫（camelCase 相容前端）"
```

---

### Task 4: error.rs + state.rs — ApiError 與事件匯流排

**Files:**
- Create: `crates/core/src/error.rs`
- Create: `crates/core/src/state.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod error; pub mod state;`、`pub use`）

- [ ] **Step 1: 寫失敗測試（state.rs 內）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreEvent;

    #[tokio::test]
    async fn test_event_bus_publish_subscribe() {
        let state = CoreState::new_for_test();
        let mut rx = state.subscribe();
        state.emit(CoreEvent::RpcServerStatus(true));
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev, CoreEvent::RpcServerStatus(true)));
    }

    #[test]
    fn test_api_error_json_shape() {
        let err = ApiError {
            status: 404,
            code: "model_not_found",
            message: "找不到".into(),
        };
        let json = serde_json::to_value(&err.body()).unwrap();
        assert_eq!(json["error"]["type"], "invalid_request_error");
        assert_eq!(json["error"]["code"], "model_not_found");
    }
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core state`**
  Expected: FAIL

- [ ] **Step 3: 實作 error.rs**

```rust
use serde::Serialize;

/// OpenAI 風格錯誤 body（對齊現行代理回應格式）
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorInner<'a>,
}

#[derive(Serialize)]
struct ErrorInner<'a> {
    message: &'a str,
    #[serde(rename = "type")]
    error_type: &'a str,
    code: &'a str,
}

impl ApiError {
    pub fn body(&self) -> ErrorBody<'_> {
        ErrorBody {
            error: ErrorInner {
                message: &self.message,
                error_type: "invalid_request_error",
                code: self.code,
            },
        }
    }
}
```

- [ ] **Step 4: 實作 state.rs**

```rust
use crate::CoreEvent;
use crate::config::Config;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};

/// 核心共享狀態：事件匯流排 + 設定。
/// RPC/backend/proxy manager 於各自 Task 中掛載至此（Option/Arc 欄位）。
pub struct CoreState {
    config: Mutex<Config>,
    events: broadcast::Sender<CoreEvent>,
}

impl CoreState {
    pub fn new(config: Config) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            config: Mutex::new(config),
            events,
        })
    }

    /// 測試用：預設設定
    pub fn new_for_test() -> Arc<Self> {
        Self::new(Config::default())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    /// 發布事件（無訂閱者時靜默忽略）
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    pub async fn config(&self) -> Config {
        self.config.lock().await.clone()
    }

    pub async fn update_config(&self, config: Config) {
        *self.config.lock().await = config;
    }
}
```

- [ ] **Step 5: lib.rs 加入模組與 re-export**

```rust
pub mod error;
pub mod state;

pub use error::ApiError;
```

- [ ] **Step 6: Run: `cargo test -p llama-dist-core`**
  Expected: PASS（先前測試 + 新測試全綠）

- [ ] **Step 7: Commit**

```bash
git add crates/core/src/error.rs crates/core/src/state.rs crates/core/src/lib.rs
git commit -m "feat(core): ApiError 錯誤結構與 CoreState 事件匯流排"
```

---

### Task 5: models.rs — GGUF 掃描、四級匹配、記憶體評估

對照 index.js `get-models` handler、`findMatchingModel` 四級規則、`loadModelBackend` 記憶體檢查。全部抽成純函式。

**Files:**
- Create: `crates/core/src/models.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod models;`）

- [ ] **Step 1: 寫失敗測試**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> Vec<String> {
        vec![
            "Qwen2.5-7B-Q4_K_M.gguf".into(),
            "Llama-3-8B-Instruct.Q4_K_M.gguf".into(),
        ]
    }

    #[test]
    fn test_match_exact_with_extension() {
        assert_eq!(
            match_model(&files(), "Qwen2.5-7B-Q4_K_M.gguf"),
            Some("Qwen2.5-7B-Q4_K_M.gguf".into())
        );
    }

    #[test]
    fn test_match_exact_without_extension() {
        assert_eq!(
            match_model(&files(), "Qwen2.5-7B-Q4_K_M"),
            Some("Qwen2.5-7B-Q4_K_M.gguf".into())
        );
    }

    #[test]
    fn test_match_case_insensitive() {
        assert_eq!(
            match_model(&files(), "llama-3-8b-instruct.q4_k_m"),
            Some("Llama-3-8B-Instruct.Q4_K_M.gguf".into())
        );
    }

    #[test]
    fn test_match_substring_both_directions() {
        // 請求是檔名的子字串
        assert_eq!(
            match_model(&files(), "Qwen2.5"),
            Some("Qwen2.5-7B-Q4_K_M.gguf".into())
        );
        // 檔名（去副檔名）是請求的子字串
        assert_eq!(
            match_model(&files(), "org/Qwen2.5-7B-Q4_K_M-GGUF"),
            Some("Qwen2.5-7B-Q4_K_M.gguf".into())
        );
    }

    #[test]
    fn test_match_none() {
        assert_eq!(match_model(&files(), "Mistral-7B"), None);
        assert_eq!(match_model(&files(), ""), None);
    }

    #[test]
    fn test_memory_hard_limit_reject() {
        // 模型大於 totalMem - 1GB → 拒絕
        let total: u64 = 8 * GB;
        let err = check_memory(9 * GB, 0, MemoryLimits { total_mem: total, free_mem: 4 * GB, max_limit_gb: 0 }).unwrap_err();
        assert!(err.contains("超出系統"));
    }

    #[test]
    fn test_memory_max_limit_gb() {
        let limits = MemoryLimits { total_mem: 32 * GB, free_mem: 16 * GB, max_limit_gb: 10 };
        let err = check_memory(11u64 * GB, 0, limits).unwrap_err();
        assert!(err.contains("上限"));
    }

    #[test]
    fn test_memory_warning_only_when_free_low() {
        // 不超過硬上限、不超過 GB 上限，但可用記憶體不足 → 只回傳警告
        let limits = MemoryLimits { total_mem: 16 * GB, free_mem: 2 * GB, max_limit_gb: 0 };
        let (warn, ok) = check_memory(6 * GB, 0, limits).unwrap();
        assert!(ok);
        assert!(warn.is_some());
    }

    const GB: u64 = 1024 * 1024 * 1024;
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core models`**
  Expected: FAIL

- [ ] **Step 3: 實作 models.rs**

```rust
use std::path::Path;

const GB: u64 = 1024 * 1024 * 1024;
const BUFFER_BYTES: u64 = 512 * 1024 * 1024; // 512MB 系統緩衝
const SYSTEM_RESERVE: u64 = 1024 * 1024 * 1024; // 1GB 系統保留

/// 掃描資料夾中的 .gguf 檔（不存在則建立並寫 README，回傳空清單；
/// 對齊 index.js get-models handler 行為）
pub fn scan_or_init_models_dir(dir: &Path) -> std::io::Result<Vec<String>> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
        let readme = "# 模型資料夾\n\n請將您的 GGUF 格式模型檔案放置於此資料夾中。\n\n## 支援的模型格式\n- `.gguf` 檔案\n\n## 建議的模型來源\n- [Hugging Face](https://huggingface.co/models?library=gguf)\n";
        std::fs::write(dir.join("README.md"), readme)?;
        return Ok(vec![]);
    }
    let mut out: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".gguf") {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// 四級模型匹配（對齊 findMatchingModel）：
/// 1. 精確（含副檔名）2. 精確（補 .gguf）3. 大小寫無關 4. 雙向子字串
pub fn match_model(files: &[String], requested: &str) -> Option<String> {
    if requested.is_empty() {
        return None;
    }
    // 1
    if files.iter().any(|f| f == requested) {
        return Some(requested.to_string());
    }
    // 2
    let with_ext = format!("{requested}.gguf");
    if files.iter().any(|f| *f == with_ext) {
        return Some(with_ext);
    }
    // 3
    let lower = requested.to_lowercase();
    if let Some(f) = files
        .iter()
        .find(|f| f.to_lowercase() == lower || f.to_lowercase() == format!("{lower}.gguf"))
    {
        return Some(f.clone());
    }
    // 4
    files.iter().find(|f| {
        let fl = f.to_lowercase();
        let stem = fl.strip_suffix(".gguf").unwrap_or(&fl);
        fl.contains(&lower) || lower.contains(stem)
    }).cloned()
}

/// 記憶體限制參數
pub struct MemoryLimits {
    pub total_mem: u64,
    pub free_mem: u64,
    /// GB，0 = 無限制
    pub max_limit_gb: u32,
}

/// 記憶體硬性檢查（對齊 loadModelBackend 步驟 2）。
/// 回傳 Err(String) 表示拒絕載入；Ok(Some(warning)) 表示可載入但需警告。
pub fn check_memory(
    model_size: u64,
    running_model_size: u64,
    limits: MemoryLimits,
) -> Result<(Option<String>, bool), String> {
    if limits.max_limit_gb > 0 {
        let limit_bytes = limits.max_limit_gb as u64 * GB;
        if model_size > limit_bytes {
            return Err(format!(
                "模型大小 ({:.2} GB) 超出設定的記憶體上限限制 ({}) GB。",
                model_size as f64 / GB as f64, limits.max_limit_gb
            ));
        }
    }
    if model_size > limits.total_mem.saturating_sub(SYSTEM_RESERVE) {
        return Err(format!(
            "模型大小 ({:.2} GB) 超出系統總記憶體限制 ({:.2} GB)。",
            model_size as f64 / GB as f64, limits.total_mem as f64 / GB as f64
        ));
    }
    let predicted_free = limits.free_mem + running_model_size;
    let required = model_size + BUFFER_BYTES;
    if predicted_free < required {
        let warn = format!(
            "[記憶體警告] 目前實際記憶體({:.2} GB) 少於模型大小+緩衝區({:.2} GB)，系統可能會使用虛擬記憶體並減慢推理速度。\n",
            predicted_free as f64 / GB as f64, required as f64 / GB as f64
        );
        return Ok((Some(warn), true));
    }
    Ok((None, true))
}

#[cfg(test)]
mod tests { /* 如 Step 1 所示，原樣貼入 */ }
```

**檔案組裝說明：** `models.rs` 的最終內容 = Step 3 的實作碼（不含末尾的 `mod tests` 佔位行）+ Step 1 的完整 `mod tests` 區塊（原樣貼於檔尾）。兩者合併後不得殘留任何 `/* ... */` 佔位註解。

- [ ] **Step 4: lib.rs 加入 `pub mod models;`**

- [ ] **Step 5: Run: `cargo test -p llama-dist-core models`**
  Expected: PASS（9 個測試）

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/models.rs crates/core/src/lib.rs
git commit -m "feat(core): models 模組 — GGUF 掃描、四級匹配、記憶體評估純函式"
```

---

### Task 6: process.rs + rpc.rs — 子進程工具與 RPC 伺服器管理

對照 index.js `startRpcServer`：`rpc-server [-H 0.0.0.0 -p 50052 -c]`、未安裝跳過、已在跑回報 true、stderr → error 事件、退出 → status false。

**Files:**
- Create: `crates/core/src/process.rs`
- Create: `crates/core/src/rpc.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 寫失敗測試（rpc.rs 內）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_start_when_not_installed_emits_nothing_and_fails() {
        let state = crate::state::CoreState::new_for_test();
        let mgr = RpcManager::new(
            state.clone(),
            std::path::PathBuf::from("Z:/definitely-not-exist/rpc-server.exe"),
        );
        let result = mgr.start().await;
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_start_stop_real_process() {
        use std::time::Duration;
        let state = crate::state::CoreState::new_for_test();
        let mgr = RpcManager::new(state.clone(), std::path::PathBuf::from("/bin/sleep"));
        // sleep 不是 rpc-server，但足以驗證 spawn/stop 生命周期
        mgr.start_with_args(["30"]).await.unwrap();
        assert!(mgr.is_running().await);
        mgr.stop().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!mgr.is_running().await);
    }
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core rpc`**
  Expected: FAIL

- [ ] **Step 3: 實作 process.rs**

先在 `crates/core/Cargo.toml` 的 `[dependencies]` 加入 reqwest（Task 7/8 的 health 檢查與轉發都會用到）：

```toml
reqwest = { version = "0.12", default-features = false, features = ["http1", "json"] }
```

實作內容：

```rust
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc::UnboundedSender;

/// 將子進程 stdout/stderr 逐行轉發至 channel。
/// stdout → tx("out")，stderr → tx("err")。
pub fn pipe_output(
    child: &mut Child,
    tx: UnboundedSender<(&'static str, String)>,
) {
    let mut stdout = child.stdout.take().expect("child stdout");
    let mut stderr = child.stderr.take().expect("child stderr");

    let tx_out = tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_out.send(("out", line)).is_err() {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(("err", line)).is_err() {
                break;
            }
        }
    });
}
```

- [ ] **Step 4: 實作 rpc.rs**

設計要點（避免所有權衝突）：
- child 存於 `Mutex<Option<Child>>`，由 `stop()` 以同步的 `start_kill()` 終止並 `take()`（自行 emit false）
- 監看任務輪詢 `try_wait()`；若鎖內已無 child（被 stop 走）→ 直接結束不發事件；若自然退出 → 清空並 emit false。事件只擇一處發。

```rust
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;

/// rpc-server 進程管理器（對齊 index.js startRpcServer/restartRpcServer/stopRpcServer）
pub struct RpcManager {
    state: Arc<CoreState>,
    binary_path: PathBuf,
    child: Mutex<Option<tokio::process::Child>>,
}

impl RpcManager {
    pub fn new(state: Arc<CoreState>, binary_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            state,
            binary_path,
            child: Mutex::new(None),
        })
    }

    /// 生產環境建構：自動解析 bin 路徑
    pub fn from_paths(state: Arc<CoreState>) -> Arc<Self> {
        Self::new(state, crate::paths::binary_path("rpc-server"))
    }

    pub async fn is_running(&self) -> bool {
        let mut guard = self.child.lock().await;
        match guard.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// 未安裝（binary 不存在）→ Err，呼叫端不啟動（對齊「未安裝跳過」邏輯）
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        self.start_with_args(["-H", "0.0.0.0", "-p", "50052", "-c"]).await
    }

    pub async fn start_with_args<I, S>(self: &Arc<Self>, args: I) -> Result<(), String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        if !self.binary_path.exists() {
            return Err("llama.cpp 尚未安裝".into());
        }
        {
            let mut guard = self.child.lock().await;
            if guard.is_some() {
                // 已在跑：對齊現行「直接回報 running」
                self.state.emit(CoreEvent::RpcServerStatus(true));
                return Ok(());
            }
        }

        let mut child = Command::new(&self.binary_path)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start rpc-server: {e}"))?;

        // stdout/stderr 行化 → 事件
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
        crate::process::pipe_output(&mut child, tx);

        {
            let state = self.state.clone();
            tokio::spawn(async move {
                while let Some((kind, line)) = rx.recv().await {
                    if kind == "err" {
                        state.emit(CoreEvent::RpcServerError(line));
                    } else {
                        state.emit(CoreEvent::RpcServerLog(line));
                    }
                }
            });
        }

        *self.child.lock().await = Some(child);

        // 監看任務：自然退出時發 status false（被 stop 走時不重複發）
        let this2 = self.clone();
        tokio::spawn(async move {
            loop {
                let outcome = {
                    let mut g = this2.child.lock().await;
                    match g.as_mut() {
                        Some(c) => c.try_wait().ok().flatten().map(|_| "exited"),
                        None => Some("taken"), // 已被 stop take 走
                    }
                };
                match outcome {
                    Some("taken") => break,               // stop() 已發過事件
                    Some("exited") => {
                        *this2.child.lock().await = None;
                        this2.state.emit(CoreEvent::RpcServerStatus(false));
                        break;
                    }
                    _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
                }
            }
        });

        // 對齊現行：延遲回報 running（讓 stderr 有機會先冒出啟動錯誤）
        let state3 = self.state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            state3.emit(CoreEvent::RpcServerStatus(true));
        });

        self.state
            .emit(CoreEvent::Log(crate::Subsystem::Sys, "RPC 伺服器已啟動".into()));
        Ok(())
    }

    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = *guard {
            child.start_kill(); // 同步送 SIGKILL/TerminateProcess
        }
        guard.take();
        self.state.emit(CoreEvent::RpcServerStatus(false));
    }
}
```

注意：`stop()` 發事件與監看任務「taken 分支不發」互相配合，確保退出事件恰好一次。

- [ ] **Step 5: lib.rs 加入 `pub mod process; pub mod rpc;`**

- [ ] **Step 6: Run: `cargo test -p llama-dist-core`**
  Expected: PASS（unix 測試在 Windows 上以 `#[cfg(unix)]` 跳過；其餘全綠）

- [ ] **Step 7: 手動冒煙（可選，需已下載 bin/）**

Run: `cargo build -p llama-dist-core` 確認無 warning 錯誤。

- [ ] **Step 8: Commit**

```bash
git add crates/core/src/process.rs crates/core/src/rpc.rs crates/core/src/lib.rs
git commit -m "feat(core): rpc-server 進程管理（spawn/stop/restart、輸出行化、事件發布）"
```

---

### Task 7: backend.rs — args 組裝（純函式）+ BackendManager

對照 index.js `loadModelBackend`（index.js:383-574）。本任務先做純函式 `build_backend_args` 與 health 輪詢；spawn/切換流程一併放入 `BackendManager`。

**Files:**
- Create: `crates/core/src/backend.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 寫失敗測試**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerOptions;

    fn opts() -> ServerOptions {
        ServerOptions {
            api_key: "sk-1".into(),
            rpc_nodes: vec!["192.168.1.10".into(), "127.0.0.1".into()],
            ngl: 33,
            np: 4,
            ctx_size: 8192,
            flash_attention: true,
            cache_type_k: "q8_0".into(),
            cache_type_v: "f16".into(),
            spec_enabled: true,
            draft_model: "draft-q4.gguf".into(),
            draft_ngl: 99,
            draft_max: 16,
            draft_min: 5,
            draft_p_min: 0.8,
            cuda_device_id: "0".into(),
            cpu_threads: 8,
            ..Default::default()
        }
    }

    #[test]
    fn test_args_full() {
        let args = build_backend_args(
            "/models/qwen.gguf",
            8081,
            "/models/draft-q4.gguf",
            &opts(),
        );
        let expect: Vec<String> = [
            "-m", "/models/qwen.gguf", "--host", "127.0.0.1", "--port", "8081",
            "--api-key", "sk-1",
            "--rpc", "192.168.1.10:50052",   // 本機節點被過濾
            "-ngl", "33", "-np", "4", "--ctx-size", "8192",
            "-fa", "-ctk", "q8_0", "-t", "8", "--device", "0",
            "-md", "/models/draft-q4.gguf", "-ngld", "99",
            "--draft-max", "16", "--draft-min", "5", "--draft-p-min", "0.8",
        ].iter().map(|s| s.to_string()).collect();
        assert_eq!(args, expect); // 注意 -ctv=f16 不出現
    }

    #[test]
    fn test_args_minimal() {
        let o = ServerOptions::default();
        let args = build_backend_args("/m.gguf", 9000, "", &o);
        assert_eq!(args, vec!["-m", "/m.gguf", "--host", "127.0.0.1", "--port", "9000"]);
    }

    #[test]
    fn test_rpc_filter_local() {
        let mut o = opts();
        o.rpc_nodes = vec!["localhost".into(), "127.0.0.1".into()];
        let args = build_backend_args("/m.gguf", 9000, "", &o);
        assert!(!args.contains(&"--rpc".to_string()));
    }
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core backend`**
  Expected: FAIL

- [ ] **Step 3: 實作 backend.rs**

```rust
use crate::config::ServerOptions;
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// 組裝 llama-server 啟動參數（逐項對齊 loadModelBackend 步驟 5）
pub fn build_backend_args(
    model_path: &str,
    port: u16,
    draft_model_path: &str,
    opts: &ServerOptions,
) -> Vec<String> {
    let mut args = vec![
        "-m".to_string(),
        model_path.to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];

    if !opts.api_key.is_empty() {
        args.extend(["--api-key".into(), opts.api_key.clone()]);
    }

    let filtered: Vec<&String> = opts
        .rpc_nodes
        .iter()
        .filter(|ip| ip.as_str() != "127.0.0.1" && ip.as_str() != "localhost" && !ip.is_empty())
        .collect();
    if !filtered.is_empty() {
        let rpc: Vec<String> = filtered.iter().map(|ip| format!("{ip}:50052")).collect();
        args.extend(["--rpc".into(), rpc.join(",")]);
    }

    if opts.ngl > 0 {
        args.extend(["-ngl".into(), opts.ngl.to_string()]);
    }
    if opts.np > 0 {
        args.extend(["-np".into(), opts.np.to_string()]);
    }
    if opts.ctx_size > 0 {
        args.extend(["--ctx-size".into(), opts.ctx_size.to_string()]);
    }
    if opts.flash_attention {
        args.push("-fa".into());
    }
    if !opts.cache_type_k.is_empty() && opts.cache_type_k != "f16" {
        args.extend(["-ctk".into(), opts.cache_type_k.clone()]);
    }
    if !opts.cache_type_v.is_empty() && opts.cache_type_v != "f16" {
        args.extend(["-ctv".into(), opts.cache_type_v.clone()]);
    }
    if opts.cpu_threads > 0 {
        args.extend(["-t".into(), opts.cpu_threads.to_string()]);
    }
    if !opts.cuda_device_id.is_empty() {
        args.extend(["--device".into(), opts.cuda_device_id.clone()]);
    }

    if opts.spec_enabled && !opts.draft_model.is_empty() && !draft_model_path.is_empty() {
        args.extend(["-md".into(), draft_model_path.to_string()]);
        if opts.draft_ngl > 0 {
            args.extend(["-ngld".into(), opts.draft_ngl.to_string()]);
        }
        if opts.draft_max > 0 {
            args.extend(["--draft-max".into(), opts.draft_max.to_string()]);
        }
        if opts.draft_min > 0 {
            args.extend(["--draft-min".into(), opts.draft_min.to_string()]);
        }
        if opts.draft_p_min > 0.0 {
            args.extend(["--draft-p-min".into(), opts.draft_p_min.to_string()]);
        }
    }

    args
}

/// 找尋自 port 起的第一個空閒埠（對齊 getFreePort）
pub async fn get_free_port(start: u16) -> u16 {
    for port in start..start + 500 {
        if tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return port;
        }
    }
    start
}

/// 輪詢 http://127.0.0.1:{port}/health 直到 200 或逾時（500ms 間隔 / 60s 上限）
pub async fn wait_health(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        if client.get(&url).send().await.is_ok_and(|r| r.status() == reqwest::StatusCode::OK) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("等待推理引擎啟動超時。".into())
}

/// backend 進程狀態（供 proxy 與 commands 查詢）
pub struct BackendHandle {
    pub model_name: String,
    pub port: u16,
    child: Mutex<Option<tokio::process::Child>>,
}

/// llama-server backend 管理器
pub struct BackendManager {
    state: Arc<CoreState>,
    server_path: PathBuf,
    models_dir: PathBuf,
    current: Mutex<Option<BackendHandle>>,
}

impl BackendManager {
    pub fn new(state: Arc<CoreState>, server_path: PathBuf, models_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            state,
            server_path,
            models_dir,
            current: Mutex::new(None),
        })
    }

    pub async fn active_model(&self) -> Option<String> {
        self.current.lock().await.as_ref().map(|h| h.model_name.clone())
    }

    pub async fn active_port(&self) -> Option<u16> {
        self.current.lock().await.as_ref().map(|h| h.port)
    }

    /// 載入模型（含切換：先停舊、等 1 秒、再起新）
    pub async fn load_model(
        &self,
        model_name: &str,
        opts: &ServerOptions,
    ) -> Result<(), String> {
        if !self.server_path.exists() {
            return Err("尚未安裝 llama.cpp 核心，請先更新安裝。".into());
        }
        let model_path = self.models_dir.join(model_name);
        if !model_path.exists() {
            return Err(format!("找不到模型檔案: {model_name}"));
        }
        let model_size = std::fs::metadata(&model_path)
            .map_err(|e| e.to_string())?
            .len();

        // 記憶體硬性檢查
        let running_size = self.active_model().await
            .and_then(|m| std::fs::metadata(self.models_dir.join(&m)).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        let limits = crate::models::MemoryLimits {
            total_mem: sys_total_mem(),
            free_mem: sys_free_mem(),
            max_limit_gb: opts.max_memory_limit,
        };
        let (warning, _) = crate::models::check_memory(model_size, running_size, limits)?;

        // 停掉現有 backend
        if self.current.lock().await.is_some() {
            self.state.emit(CoreEvent::ApiServerLog(
                "[系統] 正在卸載模型以釋放記憶體...\n".into(),
            ));
            self.stop_current().await;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        if let Some(w) = warning {
            self.state.emit(CoreEvent::ApiServerLog(w));
        }

        let port = get_free_port(8081).await;
        let draft_path = if opts.spec_enabled && !opts.draft_model.is_empty() {
            self.models_dir.join(&opts.draft_model).to_string_lossy().to_string()
        } else {
            String::new()
        };
        let args = build_backend_args(
            &model_path.to_string_lossy(),
            port,
            &draft_path,
            opts,
        );

        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: format!("載入模型中 ({model_name})"),
            loaded_model: Some(model_name.into()),
        });

        let mut child = tokio::process::Command::new(&self.server_path)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("無法啟動 llama-server: {e}"))?;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        crate::process::pipe_output(&mut child, tx);
        let st = self.state.clone();
        tokio::spawn(async move {
            while let Some((kind, line)) = rx.recv().await {
                if kind == "err" {
                    st.emit(CoreEvent::ApiServerError(line));
                } else {
                    st.emit(CoreEvent::ApiServerLog(format!("{line}\n")));
                }
            }
        });

        if let Err(e) = wait_health(port).await {
            let mut child = child;
            let _ = child.kill().await;
            return Err(e);
        }

        *self.current.lock().await = Some(BackendHandle {
            model_name: model_name.into(),
            port,
            child: Mutex::new(Some(child)),
        });

        self.state.emit(CoreEvent::ApiServerLog(
            format!("[系統] 模型 \"{model_name}\" 載入完成，推理引擎已就緒。\n"),
        ));
        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: format!("運行中 (已載入: {model_name})"),
            loaded_model: Some(model_name.into()),
        });
        Ok(())
    }

    /// 卸載目前 backend（proxy 保持運行）
    pub async fn stop_current(&self) {
        let handle = self.current.lock().await.take();
        if let Some(h) = handle {
            let mut c = h.child.lock().await;
            if let Some(child) = c.as_mut() {
                child.start_kill();
            }
        }
    }

    pub async fn is_loaded(&self) -> bool {
        self.current.lock().await.is_some()
    }
}

// 系統記憶體查詢（Phase 1 用最小實作；Windows API via winapi/sysinfo 於 Phase 2 視需要替換）
fn sys_total_mem() -> u64 {
    // 使用 /proc/meminfo（unix）或 GlobalMemoryStatusEx；此處以 crate sysinfo 最小相依
    memory_info().map(|(t, _)| t).unwrap_or(u64::MAX / 2)
}
fn sys_free_mem() -> u64 {
    memory_info().map(|(_, f)| f).unwrap_or(0)
}
fn memory_info() -> Option<(u64, u64)> {
    // 引入 sysinfo crate 太重；改讀取平台原生：
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
        let get = |key: &str| -> Option<u64> {
            txt.lines().find(|l| l.starts_with(key))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024)
        };
        Some((get("MemTotal:")?, get("MemAvailable:")?))
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Windows/macOS：呼叫 PowerShell/sysctl 太慢 —— Phase 1 以 command 取得
        #[cfg(windows)]
        {
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command",
                    "$os=Get-CimInstance Win32_OperatingSystem; \"$($os.TotalVisibleMemorySize),$($os.FreePhysicalMemory)\""])
                .output().ok()?;
            let s = String::from_utf8_lossy(&out.stdout);
            let mut it = s.trim().split(',');
            let total_kb: u64 = it.next()?.parse().ok()?;
            let free_kb: u64 = it.next()?.trim().parse().ok()?;
            Some((total_kb * 1024, free_kb * 1024))
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
            let total: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
            Some((total, total / 2)) // macOS 無簡易 free；保守估半數
        }
    }
}

#[cfg(test)]
mod tests { /* Step 1 測試原樣貼入 */ }
```

**檔案組裝說明：** `backend.rs` 的最終內容 = Step 3 的實作碼（不含末尾的 `mod tests` 佔位行）+ Step 1 的完整 `mod tests` 區塊（原樣貼於檔尾）。兩者合併後不得殘留任何 `/* ... */` 佔位註解。

- [ ] **Step 4: lib.rs 加入 `pub mod backend;`**

- [ ] **Step 5: Run: `cargo test -p llama-dist-core backend`**
  Expected: PASS（3 個測試）

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/backend.rs crates/core/src/lib.rs
git commit -m "feat(core): backend 管理 — args 組裝、free port、health 等待、載入/切換流程"
```

---

### Task 8: proxy.rs — axum 代理與切換決策

對照 index.js `startProxyServer`（index.js:576-790）：`0.0.0.0:8080`、JSON body 解析 model 欄位、四種拒絕碼、轉發。決策邏輯抽成純函式 `resolve_target` + `check_switch`。

**Files:**
- Create: `crates/core/src/proxy.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 寫失敗測試**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerOptions;

    fn files() -> Vec<String> {
        vec!["A-Q4.gguf".into(), "B-Q4.gguf".into()]
    }

    #[test]
    fn resolve_uses_requested_when_matched() {
        let t = resolve_target(Some("B-Q4"), None, None, &files());
        assert_eq!(t.unwrap(), "B-Q4.gguf");
    }

    #[test]
    fn resolve_not_found_error() {
        let t = resolve_target(Some("nope"), None, None, &files());
        let err = t.unwrap_err();
        assert_eq!(err.status, 404);
        assert_eq!(err.code, "model_not_found");
    }

    #[test]
    fn resolve_falls_back_to_options_model() {
        let mut o = ServerOptions::default();
        o.model_name = "A-Q4.gguf".into();
        let t = resolve_target(None, None, Some(&o), &files());
        assert_eq!(t.unwrap(), "A-Q4.gguf");
    }

    #[test]
    fn switch_same_model_allowed() {
        let o = ServerOptions { restrict_single_model: true, auto_load_enabled: false, ..Default::default() };
        let size_of = |_: &str| -> Option<u64> { None };
        assert!(check_switch("A-Q4.gguf", Some("A-Q4.gguf"), &o, &files(), &size_of).is_ok());
    }

    #[test]
    fn switch_restrict_blocked() {
        let o = ServerOptions { restrict_single_model: true, ..Default::default() };
        let size_of = |_: &str| -> Option<u64> { None };
        let err = check_switch("B-Q4.gguf", Some("A-Q4.gguf"), &o, &files(), &size_of).unwrap_err();
        assert_eq!(err.code, "model_switching_restricted");
        assert_eq!(err.status, 400);
    }

    #[test]
    fn switch_autoload_disabled_blocked() {
        let o = ServerOptions { auto_load_enabled: false, ..Default::default() };
        let size_of = |_: &str| -> Option<u64> { None };
        let err = check_switch("B-Q4.gguf", None, &o, &files(), &size_of).unwrap_err();
        assert_eq!(err.code, "auto_load_disabled");
    }

    #[test]
    fn switch_memory_limit_blocked() {
        let o = ServerOptions { max_memory_limit: 1, ..Default::default() }; // 1GB
        // 注入：每個模型都是 2 GB → 超出 1 GB 上限
        let size_of = |_: &str| -> Option<u64> { Some(2 * GB) };
        let err = check_switch("B-Q4.gguf", None, &o, &files(), &size_of).unwrap_err();
        assert_eq!(err.code, "memory_limit_exceeded");
    }

    const GB: u64 = 1024 * 1024 * 1024;
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core proxy`**
  Expected: FAIL

- [ ] **Step 3: 實作 proxy.rs**

```rust
use crate::backend::BackendManager;
use crate::config::ServerOptions;
use crate::error::ApiError;
use crate::state::CoreState;
use crate::CoreEvent;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use std::sync::Arc;

const PROXY_PORT: u16 = 8080;

/// 解析請求的目標模型（對齊 startProxyServer 前段）。
/// requested: body.model；active: 目前載入；opts_model: lastServerOptions.modelName
pub fn resolve_target(
    requested: Option<&str>,
    active: Option<&str>,
    opts_model: Option<&ServerOptions>,
    available: &[String],
) -> Result<Option<String>, ApiError> {
    if let Some(req) = requested.filter(|s| !s.is_empty()) {
        return match crate::models::match_model(available, req) {
            Some(m) => Ok(Some(m)),
            None => Err(ApiError {
                status: 404,
                code: "model_not_found",
                message: format!(
                    "找不到所要求的模型: \"{req}\"。請在儀表板下載並放置此模型。"
                ),
            }),
        };
    }
    if active.is_some() {
        return Ok(active.map(String::from));
    }
    if let Some(o) = opts_model {
        if !o.model_name.is_empty() && available.iter().any(|f| *f == o.model_name) {
            return Ok(Some(o.model_name.clone()));
        }
    }
    Ok(None)
}

/// 模型切換前的三道檢查（restrict / autoload / memory limit）。
/// size_of: 模型大小查詢（GB 換算由實作決定，此處回傳 bytes）
pub fn check_switch(
    target: &str,
    active: Option<&str>,
    opts: &ServerOptions,
    _available: &[String],
    size_of: &dyn Fn(&str) -> Option<u64>,
) -> Result<(), ApiError> {
    if Some(target) == active {
        return Ok(());
    }
    if opts.restrict_single_model {
        let locked = active.map(String::from).unwrap_or_else(|| opts.model_name.clone());
        if !locked.is_empty() && target != locked {
            return Err(ApiError {
                status: 400,
                code: "model_switching_restricted",
                message: format!(
                    "API 伺服器已設定為限制運行單一模型，不允許動態切換。目前指定模型為 \"{locked}\"，而請求的模型是 \"{target}\"。"
                ),
            });
        }
    }
    if !opts.auto_load_enabled && active.is_none() {
        return Err(ApiError {
            status: 400,
            code: "auto_load_disabled",
            message: format!(
                "即時模型載入 (On-demand loading) 已停用。請在主面板選擇模型\"{target}\"。"
            ),
        });
    }
    if opts.max_memory_limit > 0 {
        if let Some(size) = size_of(target) {
            let gb = opts.max_memory_limit as u64 * 1024 * 1024 * 1024;
            if size > gb {
                return Err(ApiError {
                    status: 400,
                    code: "memory_limit_exceeded",
                    message: format!(
                        "模型 \"{target}\" 的大小({:.2} GB) 超出設定的記憶體上限限制 ({} GB)。",
                        size as f64 / (1024.0 * 1024.0 * 1024.0), opts.max_memory_limit
                    ),
                });
            }
        }
    }
    Ok(())
}

fn error_response(err: &ApiError) -> Response {
    let body = serde_json::to_string(&err.body()).unwrap_or_default();
    Response::builder()
        .status(StatusCode::from_u16(err.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

/// 代理伺服器
pub struct ProxyServer {
    state: Arc<CoreState>,
    backend: Arc<BackendManager>,
    idle_notify: Arc<tokio::sync::Notify>,
}

impl ProxyServer {
    pub fn new(
        state: Arc<CoreState>,
        backend: Arc<BackendManager>,
        idle_notify: Arc<tokio::sync::Notify>,
    ) -> Arc<Self> {
        Arc::new(Self { state, backend, idle_notify })
    }

    pub async fn run(
        self: Arc<Self>,
        shutdown: tokio::sync::watch::Receiver<bool>,
        options: ServerOptions,
        models_dir: std::path::PathBuf,
    ) -> Result<(), String> {
        let models = crate::models::scan_or_init_models_dir(&models_dir)
            .map_err(|e| e.to_string())?;

        let app_state = ProxyCtx {
            me: self.clone(),
            options: Arc::new(tokio::sync::RwLock::new(options)),
            models: Arc::new(tokio::sync::RwLock::new(models)),
            models_dir,
        };

        let router = axum::Router::new()
            .fallback(handle_all)
            .with_state(app_state);

        let listener = tokio::net::TcpListener::bind(("0.0.0.0", PROXY_PORT))
            .await
            .map_err(|e| format!("Failed to start API Proxy Server: {e}"))?;

        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: "待機中 (未載入模型)".into(),
            loaded_model: None,
        });

        let mut shutdown = shutdown;
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown.changed().await;
            })
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Clone)]
struct ProxyCtx {
    me: Arc<ProxyServer>,
    options: Arc<tokio::sync::RwLock<ServerOptions>>,
    models: Arc<tokio::sync::RwLock<Vec<String>>>,
    models_dir: std::path::PathBuf,
}

async fn handle_all(
    State(ctx): State<ProxyCtx>,
    req: Request,
) -> Response {
    // 重置閒置計時器
    ctx.me.touch_idle().await;

    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return error_response(&ApiError {
                status: 500, code: "internal", message: format!("Proxy internal error: {e}"),
            });
        }
    };

    // 解析 body.model
    let requested: Option<String> = parts
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .filter(|ct| ct.contains("application/json"))
        .and_then(|_| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("model").and_then(|m| m.as_str().map(String::from)));

    let active = ctx.me.backend.active_model().await;
    let opts = ctx.options.read().await.clone();
    let available = ctx.models.read().await.clone();

    let target = match resolve_target(
        requested.as_deref(),
        active.as_deref(),
        Some(&opts),
        &available,
    ) {
        Ok(t) => t,
        Err(e) => return error_response(&e),
    };

    if let Some(t) = target {
        if Some(&t) != active.as_ref() {
            let size_of = |name: &str| -> Option<u64> {
                std::fs::metadata(ctx.models_dir.join(name)).ok().map(|m| m.len())
            };
            if let Err(e) = check_switch(&t, active.as_deref(), &opts, &available, &size_of) {
                return error_response(&e);
            }
            ctx.me.state.emit(CoreEvent::ApiServerLog(
                format!("[閒置管理] 偵測到請求指定模型\"{t}\"，開始自動載入...\n"),
            ));
            if let Err(e) = ctx.me.backend.load_model(&t, &opts).await {
                return error_response(&ApiError {
                    status: 500, code: "load_failed", message: e,
                });
            }
        }
    }

    let port = match ctx.me.backend.active_port().await {
        Some(p) => p,
        None => {
            return error_response(&ApiError {
                status: 503,
                code: "no_active_model",
                message: "推理引擎尚未啟動，或自動載入失敗。".into(),
            });
        }
    };

    // 轉發
    let uri = parts.uri.to_string();
    let url = format!("http://127.0.0.1:{port}{uri}");
    forward(url, parts.method, parts.headers, bytes.to_vec()).await
}

async fn forward(
    url: String,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
) -> Response {
    let client = reqwest::Client::new();
    let mut req = client.request(method, &url);
    for (k, v) in headers.iter() {
        if k != axum::http::header::HOST && k != axum::http::header::CONTENT_LENGTH {
            req = req.header(k.as_str(), v.to_str().unwrap_or_default());
        }
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status();
            let mut builder = Response::builder().status(status);
            for (k, v) in res.headers().iter() {
                builder = builder.header(k.as_str(), v.to_str().unwrap_or_default());
            }
            let bytes = res.bytes().await.unwrap_or_default();
            builder.body(Body::from(bytes)).unwrap_or_else(|_| {
                error_response(&ApiError { status: 502, code: "bad_gateway", message: "上游回應轉換失敗".into() })
            })
        }
        Err(e) => error_response(&ApiError {
            status: 502,
            code: "bad_gateway",
            message: format!("內部代理轉發錯誤: {e}"),
        }),
    }
}

impl ProxyServer {
    /// 閒置計時：每次請求 touch；idle_timeout 分鐘後觸發 unload（0 = 停用）。
    /// idle_notify 於 Task 9 的 ApiManager 建構時傳入。
    async fn touch_idle(&self) {
        self.idle_notify.notify_one();
    }
}
```

**備註：** `idle_notify` 由 Task 9 的 `ApiManager::new` 傳入；reqwest 依賴已於 Task 6 Step 3 加入。

- [ ] **Step 4: lib.rs 加入 `pub mod proxy;`**

- [ ] **Step 5: Run: `cargo test -p llama-dist-core`**
  Expected: PASS（全部測試綠）

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/proxy.rs crates/core/src/lib.rs crates/core/Cargo.toml
git commit -m "feat(core): axum API 代理 — 模型決策、四道拒絕碼、轉發（對齊現行行為）"
```

---

### Task 9: 閒置卸載 + ApiManager 整合層

把「start-api-server / stop-api-server / unload-model / idle timer」封裝成 `ApiManager`（對齊 index.js `start-api-server`、`stop-api-server`、`unloadModelDueToIdle`、`resetIdleTimer`），供後續 Tauri commands 與 control 伺服器直接調用。

**Files:**
- Create: `crates/core/src/api.rs`
- Modify: `crates/core/src/lib.rs`
- Modify: `crates/core/src/state.rs`（加 idle Notify）

- [ ] **Step 1: 寫失敗測試（api.rs 內）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CoreState;

    #[tokio::test]
    async fn test_idle_duration_calc() {
        assert_eq!(idle_duration(0), None);
        assert_eq!(idle_duration(5), Some(std::time::Duration::from_secs(300)));
    }

    #[tokio::test]
    async fn test_start_twice_rejected_without_binary() {
        let state = CoreState::new_for_test();
        let mgr = ApiManager::new_for_test(state.clone());
        // backend binary 不存在 → start 失敗（尚未安裝）
        let r = mgr.start(ServerOptions::default()).await;
        assert!(r.is_err());
    }
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core api`**
  Expected: FAIL

- [ ] **Step 3: 實作 api.rs**

```rust
use crate::backend::BackendManager;
use crate::config::ServerOptions;
use crate::proxy::ProxyServer;
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify, watch};

pub fn idle_duration(minutes: u32) -> Option<Duration> {
    if minutes == 0 { None } else { Some(Duration::from_secs(minutes as u64 * 60)) }
}

/// API 伺服器整體管理：proxy 生命周期 + backend + 閒置卸載
/// （對齊 index.js start-api-server / stop-api-server / unloadModelDueToIdle）
pub struct ApiManager {
    state: Arc<CoreState>,
    backend: Arc<BackendManager>,
    proxy: Arc<ProxyServer>,
    /// 每次成功 start 建立一組 shutdown channel，stop 時全部觸發
    shutdown_txs: Mutex<Vec<watch::Sender<bool>>>,
    idle_notify: Arc<Notify>,
    last_options: Arc<tokio::sync::RwLock<Option<ServerOptions>>>,
    models_dir: PathBuf,
}

impl ApiManager {
    pub fn new(state: Arc<CoreState>, models_dir: PathBuf) -> Arc<Self> {
        let idle_notify = Arc::new(Notify::new());
        let backend = BackendManager::new(
            state.clone(),
            crate::paths::binary_path("llama-server"),
            models_dir.clone(),
        );
        let proxy = ProxyServer::new(state.clone(), backend.clone(), idle_notify.clone());
        Arc::new(Self {
            state,
            backend,
            proxy,
            shutdown_txs: Mutex::new(Vec::new()),
            idle_notify,
            last_options: Arc::new(tokio::sync::RwLock::new(None)),
            models_dir,
        })
    }

    /// 測試建構：指向不存在的二進位與暫存 models 目錄
    pub fn new_for_test(state: Arc<CoreState>) -> Arc<Self> {
        Self::new(state, std::env::temp_dir().join("llama-dist-test-models"))
    }

    pub fn backend(&self) -> &Arc<BackendManager> {
        &self.backend
    }

    pub async fn last_options(&self) -> Option<ServerOptions> {
        self.last_options.read().await.clone()
    }

    /// 對齊 start-api-server handler：啟 proxy（背景）、記住 options、啟動閒置監看
    pub async fn start(&self, options: ServerOptions) -> Result<(), String> {
        if !crate::paths::is_installed() {
            return Err("尚未安裝 llama.cpp 核心檔案，請先更新安裝。".into());
        }
        if self.proxy_is_running().await {
            return Err("API 主伺服器已在運行中".into());
        }
        *self.last_options.write().await = Some(options.clone());

        // proxy 生命周期（獨立 shutdown channel）
        let (tx, rx) = watch::channel(false);
        self.shutdown_txs.lock().await.push(tx);
        let proxy = self.proxy.clone();
        let opts = options.clone();
        let models_dir = self.models_dir.clone();
        tokio::spawn(async move {
            let _ = proxy.run(rx, opts, models_dir).await;
        });

        // 閒置監看任務（每次 start 產生一個；stop 後由 shutdown 觀察退出）
        let notify = self.idle_notify.clone();
        let last = self.last_options.clone();
        let state = self.state.clone();
        let backend = self.backend.clone();
        tokio::spawn(async move {
            loop {
                let dur = {
                    let lo = last.read().await;
                    lo.as_ref().and_then(|o| idle_duration(o.idle_timeout))
                };
                match dur {
                    None => notify.notified().await, // 停用：只等 touch 重置
                    Some(d) => {
                        if tokio::time::timeout(d, notify.notified()).await.is_err() {
                            // 閒置逾時 → 卸載模型（proxy 持續運行）
                            if backend.is_loaded().await {
                                if let Some(m) = backend.active_model().await {
                                    state.emit(CoreEvent::ApiServerLog(format!(
                                        "[閒置管理] 偵測到已閒置，自動卸載模型 \"{m}\" 以釋放系統資源...\n"
                                    )));
                                    backend.stop_current().await;
                                    state.emit(CoreEvent::ApiServerStatus {
                                        running: true,
                                        message: "運行中 (模型已閒置卸載)".into(),
                                        loaded_model: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        });

        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: "待機中 (未載入模型)".into(),
            loaded_model: None,
        });
        Ok(())
    }

    /// 對齊 stop-api-server：關 proxy、殺 backend、重置狀態
    pub async fn stop(&self) {
        for tx in self.shutdown_txs.lock().await.drain(..) {
            let _ = tx.send(true);
        }
        self.backend.stop_current().await;
        *self.last_options.write().await = None;
        self.state.emit(CoreEvent::ApiServerStatus {
            running: false,
            message: String::new(),
            loaded_model: None,
        });
    }

    /// proxy 是否運行中（存在未關閉的 shutdown sender 即視為運行中）
    pub async fn proxy_is_running(&self) -> bool {
        !self.shutdown_txs.lock().await.is_empty()
    }
}
```

**備註：**
1. `ProxyServer` 已於 Task 8 改為 `new(state, backend, idle_notify)` 三參建構。
2. `unload-model` 對外命令即 `backend.stop_current()` + 發 `ApiServerStatus`（由 Tauri commands / control 端點直接組合，不需額外方法）。

- [ ] **Step 4: lib.rs 加入 `pub mod api;`**

- [ ] **Step 5: Run: `cargo test -p llama-dist-core`**
  Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/api.rs crates/core/src/state.rs crates/core/src/proxy.rs crates/core/src/lib.rs
git commit -m "feat(core): ApiManager 整合層 — start/stop 生命周期與閒置自動卸載"
```

---

### Task 10: 整合測試 + 全量驗證

**Files:**
- Create: `crates/core/tests/integration.rs`

- [ ] **Step 1: 寫整合測試**

```rust
use llama_dist_core::{config::Config, state::CoreState};

#[tokio::test]
async fn config_and_event_bus_integration() {
    let mut cfg = Config::default();
    cfg.api_key = "it".into();
    let state = CoreState::new(cfg.clone());
    let got = state.config().await;
    assert_eq!(got.api_key, "it");

    let mut rx = state.subscribe();
    state.emit(llama_dist_core::CoreEvent::ApiServerLog("hi".into()));
    assert!(rx.recv().await.is_ok());
}

#[test]
fn models_match_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("Test-Model-Q4.gguf");
    std::fs::write(&p, b"x").unwrap();
    let files = llama_dist_core::models::scan_or_init_models_dir(dir.path()).unwrap();
    assert_eq!(
        llama_dist_core::models::match_model(&files, "test model q4"),
        Some("Test-Model-Q4.gguf".into())
    );
}
```

- [ ] **Step 2: Run: `cargo test -p llama-dist-core`**
  Expected: PASS（全部）

- [ ] **Step 3: Run: `cargo clippy --all-targets -- -D warnings`**
  Expected: 無錯誤（允許少量 clippy pedantic 除外；`-D warnings` 級別需通過）

- [ ] **Step 4: Run: `cargo fmt --check` 或執行 `cargo fmt` 後再驗證**
  Expected: 格式化通過

- [ ] **Step 5: 手動冒煙（有 bin/ 時）**

若有 `bin/windows/llama-server.exe` 與小模型，可寫一次性範例 `examples/smoke.rs` 驗證 proxy + 載入流程；無則跳過（Phase 5 GUI 階段會全面驗證）。

- [ ] **Step 6: Commit**

```bash
git add crates/core/tests/integration.rs
git commit -m "test(core): 整合測試 — config/event bus/models 匹配端到端"
```

---

## 完成標準（Phase 0-1 Definition of Done）

- `cargo test -p llama-dist-core` 全綠
- `cargo clippy --all-targets -- -D warnings` 通過
- 行為對照表（與 index.js 一致）：
  - ✅ rpc-server spawn 參數與事件流
  - ✅ backend args 21 項參數組裝規則
  - ✅ 四級模型匹配
  - ✅ 三道切換檢查（restrict/autoload/memory）+ 404/400/400/400/503 錯誤碼
  - ✅ 記憶體雙重檢查 + 512MB 緩衝警告
  - ✅ 閒置卸載（分鐘制，0=停用）
  - ✅ 模型切換：殺舊 → 等 1s → 起新

## 後續階段（另行產出計畫）

- Phase 2: mdns + nodes（mdns-sd、節點過濾、手動節點）
- Phase 3: hf + updater（HF API 下載器、GitHub Release 更新器）
- Phase 4: control 伺服器（axum :59999 + token + SSE）
- Phase 5: Tauri GUI（commands/bridge/tray）
- Phase 6: CLI + daemon
- Phase 7: 打包 + CI
- Phase 8: 移除 Electron
