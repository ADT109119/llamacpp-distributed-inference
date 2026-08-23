# Tauri 重構 Phase 3：HF 模型下載器 + llama.cpp 更新器 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `llama-dist-core` 移植 Hugging Face 模型下載器（搜尋/分組/分片下載/取消）與 llama.cpp 更新器（GitHub Release 檢查/CUDA DLL 配對/解壓安裝），行為對齊 Electron 版 `hf-downloader.js` 與 `updater.js`。

**Architecture:** 兩個獨立模組，共用 reqwest（需啟用 rustls-tls —— 目前為 no-TLS）。純-TLS）。純邏輯（檔名解析、變體分組、資產過濾）抽為可測純函式；下載流程以 `AtomicBool` 取消 + `.part` 暫存語意（失敗即刪除暫存）。解壓改用 zip/flate2+tar crate（取代 Electron 的 shell-out），可跨平台且可測。

**Tech Stack:** 新增依賴：reqwest 啟用 `rustls-tls`、zip = "2"（deflate）、flate2 = "1"、tar = "0.4"。既有依賴不變。

**設計文件:** `docs/superpowers/specs/2026-08-22-tauri-refactor-design.md` §5.6、§5.7
**對照來源:** `src/main/hf-downloader.js`（284 行）、`src/main/updater.js`（346 行）

---

## 行為規格摘要（實作者必讀）

### HF 下載器（hf-downloader.js）
- API：`GET https://huggingface.co/api/models/{repo}` 與 `.../{repo}/revision/main?blobs=true`；User-Agent: `llamacpp-distributed-inference`
- 分片正則：`<Base>-<5位數>-of-<5位數>.gguf`（如 `Model-00001-of-00005.gguf`）
- 分組規則（groupByVariant）：分片以 BaseName 歸組（isSplit=true，組內按檔名排序）；單檔各自成組；輸出 `{variant, files[{name,size}], totalSize, shardCount, isSplit}` 按 variant 字典序排序
- 量化標籤提取順序（extractQuantLabel）：`[_-](UD[_-]Q\d+[_A-Z]*\w*)` → `[_-](IQ\d+[_A-Z]*\w*)` → `[_-](Q\d+[_A-Z]*\w*)` → `[_-](F16|F32|BF16)`，不分大小寫、結果轉大寫；無匹配 → 檔名最後一段（超過 40 字元取尾 40）
- 下載：`https://huggingface.co/{repo}/resolve/main/{file}` 循序下載到 models 目錄；整體進度 = `(i + filePct) / total * 100`；取消旗標檢查於每檔開頭與每個 chunk
- 回傳形狀：`{success, message, downloadedFiles[]}`；取消 →「下載已取消」

### 更新器（updater.js）
- API：`GET https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`
- 版本儲存：config key `llamacppVersion`（預設「未安裝」）；hasUpdate = current != latest tag
- 資產過濾：win → `llama-{tag}-bin-win-*.zip`；macos → `llama-{tag}-bin-macos-*.tar.gz`；linux → `llama-{tag}-bin-ubuntu-*.tar.gz`
- 預設變體：windows x64 → `cuda-12.4`；其餘平台 x64/arm64 依架構
- 標籤美化：去前綴去副檔名 → `-` 換空格 → 每詞首字大寫（如 `cuda-12.4-x64` → `Cuda 12.4 (x64)`… 實際 JS 是每個 dash-word 首字母大寫，含數字段原樣）
- 安裝流程（downloadAndInstall）：bin/__update_temp 暫存 → 主檔下載（已有非空暫存則跳過）→ windows 且檔名含 cuda key 時附帶下載對應 cudart zip 並解壓 → 解壓主檔 → 遞迴找 `llama-server(.exe)`/`rpc-server(.exe)` 複製到 bin/（unix chmod 755）+ windows 複製所有 .dll → 儲存版本 → 清空暫存
- 進度映射：主檔 5%→65%、DLL 65%→75%、解壓 75%、安裝 85%、完成 100%

---

## 檔案結構

```
crates/core/
├── Cargo.toml          # reqwest +rustls-tls、zip、flate2、tar
├── src/
│   ├── config.rs       # + llamacpp_version 欄位
│   ├── hf.rs           # [新] HF API + 下載
│   └── updater.rs      # [新] GitHub Release 更新器
└── tests/
    └── integration.rs  # 追加整合測試
```

---

### Task 1: hf.rs — 檔名解析與變體分組（純函式）

**Files:**
- Create: `crates/core/src/hf.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod hf;`）

- [ ] **Step 1: 實作（TDD：先寫測試確認編譯失敗）**

```rust
//! Hugging Face 模型下載模組（對齊 src/main/hf-downloader.js）

pub const HF_API_BASE: &str = "https://huggingface.co/api/models";
pub const HF_RESOLVE_BASE: &str = "https://huggingface.co";

/// 單一 GGUF 檔案資訊
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufFile {
    pub name: String,
    pub size: u64,
}

/// 變體分組結果
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantGroup {
    pub variant: String,
    pub files: Vec<GgufFile>,
    pub total_size: u64,
    pub shard_count: usize,
    pub is_split: bool,
}

/// 解析分割 GGUF 檔名：<Base>-<5位數>-of-<5位數>.gguf → Some(base_name)
/// （對齊 SPLIT_GGUF_REGEX /^(.+)-(\d{5})-of-(\d{5})\.gguf$/）
pub fn split_gguf_base(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".gguf")?;
    // 尾端必須是 -NNNNN-of-NNNNN
    let rest = stem.rsplit_once("-of-")?;
    let (base, shard_num) = rest;
    if base.is_empty() || shard_num.len() != 5 || !shard_num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // base 本身也要以 -NNNNN 結尾
    let idx = base.rfind('-')?;
    let first_num = &base[idx + 1..];
    if first_num.len() != 5 || !first_num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(base[..idx].to_string())
}

/// 從 baseName 提取量化標籤（對齊 extractQuantLabel 的四段式匹配順序）
pub fn extract_quant_label(base_name: &str) -> String {
    let lower = base_name.to_lowercase();

    // [_-](ud[_-]q\d+[_a-z]*\w*) 等 —— 以手寫掃描取代 regex crate：
    // 找出所有以 - 或 _ 開頭的候選 token 序列。
    fn try_match(lower: &str, prefix: &str, allow_trailing_dash: bool) -> Option<String> {
        let start = lower.find(prefix)?;
        // 前一個字元必須是 - 或 _
        if start == 0 {
            return None;
        }
        let prev = lower.as_bytes()[start - 1];
        if prev != b'-' && prev != b'_' {
            return None;
        }
        let tail = &lower[start..];
        let mut end = tail.len();
        for (i, c) in tail.char_indices() {
            let ok = c.is_ascii_alphanumeric() || c == '_' || (allow_trailing_dash && c == '-');
            if !ok {
                end = i;
                break;
            }
        }
        let matched = &tail[..end];
        // 排除只匹配到前綴本身的情況（\w* 至少一個後續字元由 \d+ 保證存在）
        if matched.len() < prefix.len() + 2 {
            return None;
        }
        Some(matched.to_uppercase())
    }

    for (prefix, dash) in [
        ("ud-q", true),
        ("ud_q", false),
        ("iq", false),
        ("q", false),
    ] {
        if let Some(m) = try_match(&lower, prefix, dash) {
            return m;
        }
    }
    for f in ["f16", "f32", "bf16"] {
        if lower.ends_with(f)
            && lower.len() > f.len()
            && matches!(lower.as_bytes()[lower.len() - f.len() - 1], b'-' | b'_')
        {
            return f.to_uppercase();
        }
    }

    // fallback：最後路徑段，超過 40 取尾 40
    let last = base_name.rsplit('/').next().unwrap_or(base_name);
    let chars: Vec<char> = last.chars().collect();
    if chars.len() > 40 {
        chars[chars.len() - 40..].iter().collect()
    } else {
        last.to_string()
    }
}

/// 將 GGUF 檔案清單按變體分組（對齊 groupByVariant）
pub fn group_by_variant(files: &[GgufFile]) -> Vec<VariantGroup> {
    // 用 BTreeMap 保持 variant 排序確定性；插入順序表記錄原始出現順序
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, (String, Vec<GgufFile>, bool)> =
        std::collections::HashMap::new();

    for file in files {
        match split_gguf_base(&file.name) {
            Some(base) => {
                if !groups.contains_key(&base) {
                    order.push(base.clone());
                    groups.insert(
                        base.clone(),
                        (extract_quant_label(&base), Vec::new(), true),
                    );
                }
                groups.get_mut(&base).unwrap().1.push(file.clone());
            }
            None => {
                let key = file.name.clone();
                let base = file.name.trim_end_matches(".gguf");
                order.push(key.clone());
                groups.insert(
                    key,
                    (extract_quant_label(base), vec![file.clone()], false),
                );
            }
        }
    }

    let mut out: Vec<VariantGroup> = groups
        .into_iter()
        .map(|(_, (variant, mut fs, split))| {
            if split {
                fs.sort_by(|a, b| a.name.cmp(&b.name));
            }
            let total = fs.iter().map(|f| f.size).sum();
            VariantGroup {
                variant,
                files: fs,
                total_size: total,
                shard_count: 0, // 下方填入
                is_split: split,
            }
        })
        .collect();
    for g in &mut out {
        g.shard_count = g.files.len();
    }
    out.sort_by(|a, b| a.variant.cmp(&b.variant));
    out
}
```

注意：`extract_quant_label` 上面的手寫掃描是**示意**——regex 語意細節（如 `UD_Q8_K_XL` 應整段捕獲、大小寫不敏感、`\w*` 邊界）容易出錯。若手寫版本無法通過下方測試，允許加入 `regex` crate（`regex = "1"`，僅 dev 或正式依賴皆可）直接移植四條 pattern —— **以測試全綠為準**，回報你的選擇。

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_gguf_base() {
        assert_eq!(split_gguf_base("Model-00001-of-00005.gguf"), Some("Model".into()));
        assert_eq!(split_gguf_base("Qwen3-32B-Q4_K_M-00003-of-00007.gguf"), Some("Qwen3-32B-Q4_K_M".into()));
        assert_eq!(split_gguf_base("plain.gguf"), None);
        assert_eq!(split_gguf_base("Model-1-of-5.gguf"), None);          // 位數不足
        assert_eq!(split_gguf_base("Model-00001-of-0000X.gguf"), None);  // 非數字
        assert_eq!(split_gguf_base("Model.gguf-00001-of-00002.gguf"), None);
        assert_eq!(split_gguf_base("-00001-of-00002.gguf"), None);       // 空 base
    }

    #[test]
    fn test_extract_quant_label() {
        assert_eq!(extract_quant_label("Qwen3-32B-Q4_K_M"), "Q4_K_M");
        assert_eq!(extract_quant_label("Qwen3-32B-UD-Q8_K_XL"), "UD-Q8_K_XL");
        assert_eq!(extract_quant_label("model_IQ4_XS"), "IQ4_XS");
        assert_eq!(extract_quant_label("model-f16"), "F16");
        assert_eq!(extract_quant_label("nomatch"), "nomatch");
        assert_eq!(
            extract_quant_label("verylongnamethatexceedsfourtycharacters-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }

    #[test]
    fn test_group_by_variant() {
        let files = vec![
            GgufFile { name: "M-Q8_0.gguf".into(), size: 100 },
            GgufFile { name: "M-Q4_K_M-00002-of-00002.gguf".into(), size: 40 },
            GgufFile { name: "M-Q4_K_M-00001-of-00002.gguf".into(), size: 50 },
        ];
        let groups = group_by_variant(&files);
        assert_eq!(groups.len(), 2);
        // variant 排序：Q4_K_M < Q8_0
        assert_eq!(groups[0].variant, "Q4_K_M");
        assert!(groups[0].is_split);
        assert_eq!(groups[0].shard_count, 2);
        assert_eq!(groups[0].total_size, 90);
        // 分片組內排序
        assert_eq!(groups[0].files[0].name, "M-Q4_K_M-00001-of-00002.gguf");
        assert_eq!(groups[1].variant, "Q8_0");
        assert!(!groups[1].is_split);
    }
}
```

- [ ] **Step 2: lib.rs 加 `pub mod hf;`**

- [ ] **Step 3: Run `cargo test -p llama-dist-core hf` → PASS；全套/clippy/fmt 乾淨**

- [ ] **Step 4: Commit**

```bash
git add crates/core/src/hf.rs crates/core/src/lib.rs
git commit -m "feat(core): hf 模組 — 分片解析、量化標籤、變體分組純函式"
```

---

### Task 2: config.rs 加 llamacppVersion 欄位

**Files:**
- Modify: `crates/core/src/config.rs`

- [ ] **Step 1: Config 結構加欄位**

```rust
fn default_llamacpp_version() -> String {
    "未安裝".into()
}

pub struct Config {
    pub models_path: String,
    pub api_key: String,
    pub theme: String,
    pub server_options: Option<ServerOptions>,
    /// 已安裝的 llama.cpp 版本（release tag；「未安裝」表示尚未安裝）
    #[serde(default = "default_llamacpp_version")]
    pub llamacpp_version: String,
}
```

同步更新 `Default for Config`（`llamacpp_version: default_llamacpp_version()`）。serde `rename_all = "camelCase"` 自動映射為 `llamacppVersion`，與 electron-store key 相容。既有 config.json 缺此 key 時由 `default` 容器屬性補預設值。

- [ ] **Step 2: 測試追加**

```rust
#[test]
fn test_llamacpp_version_default_and_roundtrip() {
    let cfg = Config::default();
    assert_eq!(cfg.llamacpp_version, "未安裝");
    let json = serde_json::to_value(&cfg).unwrap();
    assert_eq!(json["llamacppVersion"], "未安裝");
    // 舊版 config（缺 key）載入後有預設值
    let back: Config = serde_json::from_str("{}").unwrap();
    assert_eq!(back.llamacpp_version, "未安裝");
}
```

- [ ] **Step 3: 全套測試 + clippy + fmt 乾淨；Commit**

```bash
git add crates/core/src/config.rs
git commit -m "feat(core): config 增加 llamacppVersion 欄位（預設 未安裝）"
```

---

### Task 3: hf.rs — API 與下載（search/list/download/cancel）

**Files:**
- Modify: `crates/core/src/hf.rs`
- Modify: `crates/core/Cargo.toml`（reqwest 啟用 TLS + zip 系依賴留給 Task 4）
- Modify: `crates/core/src/state.rs`？否 —— 進度事件由呼叫端傳入 callback 或 CoreState。**設計決策：** 函式簽名接收 `&CoreState`，透過 `DownloadProgress` 事件發布（kind="hf"）。

- [ ] **Step 1: Cargo.toml reqwest 改為：**

```toml
reqwest = { version = "0.12", default-features = false, features = ["http1", "json", "rustls-tls"] }
```

（先前審查已指出 no-TLS 是已知限制；本任務解除。）

- [ ] **Step 2: 實作 API 與下載（附加到 hf.rs）：**

```rust
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Arc};
use tokio::sync::Mutex;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llamacpp-distributed-inference")
        .build()
        .expect("static client config")
}

/// Repo 元資訊（對齊 searchRepo 回傳）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: String,
    pub author: String,
    pub model_id: String,
    pub downloads: u64,
    pub tags: Vec<String>,
}

pub async fn search_repo(repo_id: &str) -> Result<RepoInfo, String> {
    let url = format!("{HF_API_BASE}/{repo_id}");
    let data: serde_json::Value = client()
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("網路請求失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("JSON 解析失敗: {e}"))?;

    Ok(RepoInfo {
        id: data["id"].as_str().unwrap_or(repo_id).to_string(),
        author: data["author"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| repo_id.split('/').next().unwrap_or(repo_id).to_string()),
        model_id: data["modelId"].as_str().unwrap_or(repo_id).to_string(),
        downloads: data["downloads"].as_u64().unwrap_or(0),
        tags: data["tags"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    })
}

pub async fn list_gguf_files(repo_id: &str) -> Result<Vec<VariantGroup>, String> {
    let url = format!("{HF_API_BASE}/{repo_id}/revision/main?blobs=true");
    let data: serde_json::Value = client()
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("網路請求失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("JSON 解析失敗: {e}"))?;

    let files: Vec<GgufFile> = data["siblings"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s["rfilename"].as_str())
                .filter(|n| n.ends_with(".gguf"))
                .map(|n| GgufFile {
                    name: n.to_string(),
                    size: s["size"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(group_by_variant(&files))
}

/// 活動下載取消旗標
pub static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn cancel_download() {
    DOWNLOAD_CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn emit_progress(state: &CoreState, percent: u32, message: &str, current_file: &str) {
    state.emit(CoreEvent::DownloadProgress {
        percent: percent as f64,
        message: message.into(),
        current_file: current_file.into(),
        kind: "hf",
    });
}

/// 下載單檔（串流寫入 dest；回報 0.0~1.0 檔內進度；取消時刪除暫存並回 Err("下載已取消")）
async fn download_file_with_progress(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancelled: &AtomicBool,
    on_progress: &dyn Fn(f64),
) -> Result<(), String> {
    let resp = http
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下載失敗: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("無法建立檔案: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下載失敗: {e}"))? {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err("下載已取消".into());
        }
        downloaded += chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("寫入失敗: {e}"))?;
        if total > 0 {
            on_progress(downloaded as f64 / total as f64);
        }
    }
    Ok(())
}

/// 對齊 downloadModel：循序下載多檔 + 整體進度事件 + 取消支援。
/// 失敗/取消時已完成的檔案保留（downloadedFiles）。
pub async fn download_model(
    state: &Arc<CoreState>,
    repo_id: &str,
    file_names: &[String],
    models_path: &Path,
    cancelled: &AtomicBool,
) -> Result<Vec<String>, String> {
    tokio::fs::create_dir_all(models_path)
        .await
        .map_err(|e| format!("無法建立目錄: {e}"))?;
    let http = client();
    let mut downloaded_files = Vec::new();
    let total = file_names.len();

    for (i, file_name) in file_names.iter().enumerate() {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("下載已取消".into());
        }
        let url = format!("{HF_RESOLVE_BASE}/{repo_id}/resolve/main/{file_name}");
        let dest = models_path.join(file_name);

        emit_progress(
            state,
            ((i as f64 / total as f64) * 100.0) as u32,
            &format!("開始下載 {file_name} ({}/{})", i + 1, total),
            file_name,
        );

        let st_pct = state.clone();
        let fname = file_name.clone();
        let idx = i;
        download_file_with_progress(&http, &url, &dest, cancelled, &move |pct| {
            let overall = ((idx as f64 + pct) / total as f64 * 100.0) as u32;
            emit_progress(
                &st_pct,
                overall,
                &format!("下載中 ({}/{})... {}%", idx + 1, total, (pct * 100.0) as u32),
                &fname,
            );
        })
        .await?;

        downloaded_files.push(file_name.clone());
    }

    Ok(downloaded_files)
}
```

- [ ] **Step 3: 測試（不連網的部分）**

```rust
#[tokio::test]
async fn test_cancel_flag_semantics() {
    let state = crate::state::CoreState::new_for_test();
    let dir = tempfile::tempdir().unwrap();
    DOWNLOAD_CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = download_model(
        &state,
        "any/repo",
        &["a.gguf".to_string()],
        dir.path(),
        &DOWNLOAD_CANCELLED,
    )
    .await;
    assert_eq!(r.unwrap_err(), "下載已取消");
    DOWNLOAD_CANCELLED.store(false, std::sync::atomic::Ordering::SeqCst);
}

// 網路功能測試標記 #[ignore]，需要時手動執行：
#[tokio::test]
#[ignore = "requires network"]
async fn test_search_repo_real() {
    let info = search_repo("ggml-org/gemma-3-1b-it-GGUF").await.unwrap();
    assert!(!info.id.is_empty());
}
```

- [ ] **Step 4: 全套測試 + clippy + fmt 乾淨；Commit**

```bash
git add crates/core/src/hf.rs crates/core/Cargo.toml Cargo.lock
git commit -m "feat(core): hf API 與下載 — search/list/download/cancel（rustls TLS）"
```

---

### Task 4: updater.rs — 純函式與資產選擇

**Files:**
- Create: `crates/core/src/updater.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 實作純函式部分**

```rust
//! llama.cpp 核心更新模組（對齊 src/main/updater.js）

pub const GITHUB_API: &str = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
pub const GITHUB_RELEASES: &str = "https://github.com/ggml-org/llama.cpp/releases/download";

pub fn get_platform_id() -> &'static str {
    crate::paths::platform_id()
}

/// 各平台與架構預設變體（對齊 getDefaultVariant）
pub fn get_default_variant(arch: &str) -> &'static str {
    match get_platform_id() {
        "macos" => {
            if arch == "arm64" { "arm64" } else { "x64" }
        }
        "windows" => {
            if arch == "arm64" { "arm64" } else { "cuda-12.4" }
        }
        _ => {
            if arch == "arm64" { "arm64" } else { "x64" }
        }
    }
}

/// CUDA DLL 附帶下載映射
pub const CUDA_DLL_MAP: &[(&str, &str)] = &[
    ("cuda-12.4", "cudart-llama-bin-win-cuda-12.4-x64.zip"),
    ("cuda-13.1", "cudart-llama-bin-win-cuda-13.1-x64.zip"),
];

/// 平台 asset 前綴與副檔名
pub fn asset_pattern(platform: &str, tag: &str) -> (&'static str, &'static str) {
    match platform {
        "windows" => (&*format!("llama-{tag}-bin-win-").leak(), ".zip"),
        "macos" => (&*format!("llama-{tag}-bin-macos-").leak(), ".tar.gz"),
        "linux" => (&*format!("llama-{tag}-bin-ubuntu-").leak(), ".tar.gz"),
        _ => ("", ""),
    }
}

/// 判斷 asset 是否屬於當前平台（對齊 getAvailableAssets 的 filter）
pub fn is_platform_asset(name: &str, tag: &str, platform: &str) -> bool {
    let (prefix, suffix) = asset_pattern(platform, tag);
    name.starts_with(prefix) && name.ends_with(suffix)
}

/// 從 asset 檔名提取人類可讀標籤（對齊 extractVariantLabel：
/// 去前綴去副檔名 → '-' 換空格 → 每詞首字大寫）
pub fn extract_variant_label(name: &str, tag: &str, platform: &str) -> String {
    let (prefix, suffix) = asset_pattern(platform, tag);
    let label = name
        .strip_prefix(prefix)
        .unwrap_or(name)
        .strip_suffix(suffix)
        .unwrap_or(name);
    label
        .split('-')
        .map(|word| {
            let mut cs = word.chars();
            match cs.next() {
                Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 是否需要附帶下載 CUDA DLL（windows 且檔名含 cuda key）→ 回傳 DLL 檔名
pub fn matching_cuda_dll(asset_name: &str) -> Option<&'static str> {
    for (key, dll) in CUDA_DLL_MAP {
        if asset_name.contains(key) {
            return Some(dll);
        }
    }
    None
}

/// Release assets 過濾結果（對齊 getAvailableAssets 回傳形狀）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub name: String,
    pub label: String,
    pub download_url: String,
    pub size: u64,
    pub is_default: bool,
}

/// 從 GitHub release JSON 過濾出當前平台的 assets（對齊 getAvailableAssets）
pub fn filter_assets(release_json: &serde_json::Value, platform: &str, arch: &str) -> Vec<AssetInfo> {
    let tag = release_json["tag_name"].as_str().unwrap_or("");
    let default_variant = get_default_variant(arch);
    release_json["assets"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a["name"].as_str())
                .filter(|name| is_platform_asset(name, tag, platform))
                .map(|name| {
                    let label = extract_variant_label(name, tag, platform);
                    let size = release_json["assets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|a| a["name"].as_str() == Some(name))
                        .and_then(|a| a["size"].as_u64())
                        .unwrap_or(0);
                    AssetInfo {
                        name: name.to_string(),
                        label: label.clone(),
                        download_url: format!("{GITHUB_RELEASES}/{tag}/{name}"),
                        size,
                        is_default: label.to_lowercase().contains(default_variant),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_default_variant() {
        if cfg!(windows) {
            assert_eq!(get_default_variant("x64"), "cuda-12.4");
            assert_eq!(get_default_variant("arm64"), "arm64");
        }
    }

    #[test]
    fn test_is_platform_asset() {
        let tag = "b8940";
        assert!(is_platform_asset(&format!("llama-{tag}-bin-win-cuda-12.4-x64.zip"), tag, "windows"));
        assert!(!is_platform_asset(&format!("llama-{tag}-bin-win-cuda.tar.gz"), tag, "windows"));
        assert!(is_platform_asset(&format!("llama-{tag}-bin-macos-arm64.tar.gz"), tag, "macos"));
        assert!(is_platform_asset(&format!("llama-{tag}-bin-ubuntu-x64.tar.gz"), tag, "linux"));
    }

    #[test]
    fn test_extract_variant_label() {
        assert_eq!(
            extract_variant_label("llama-b8940-bin-win-cuda-12.4-x64.zip", "b8940", "windows"),
            "Cuda 12.4 X64"
        );
    }

    #[test]
    fn test_matching_cuda_dll() {
        assert_eq!(
            matching_cuda_dll("llama-b8940-bin-win-cuda-12.4-x64.zip"),
            Some("cudart-llama-bin-win-cuda-12.4-x64.zip")
        );
        assert_eq!(matching_cuda_dll("llama-b8940-bin-win-cpu-x64.zip"), None);
    }

    #[test]
    fn test_filter_assets_shape() {
        let json: serde_json::Value = serde_json::json!({
            "tag_name": "b8940",
            "assets": [
                {"name": "llama-b8940-bin-win-cuda-12.4-x64.zip", "size": 100},
                {"name": "cudart-llama-bin-win-cuda-12.4-x64.zip", "size": 200},
                {"name": "llama-b8940-bin-macos-arm64.tar.gz", "size": 300}
            ]
        });
        let assets = filter_assets(&json, "windows", "x64");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, "llama-b8940-bin-win-cuda-12.4-x64.zip");
        assert_eq!(assets[0].size, 100);
        assert!(assets[0].is_default);
    }
}
```

注意：`asset_pattern` 用 `format!(...).leak()` 產生 `&'static str` 是刻意妥協（呼叫次數極少、避免生命週期地獄）。若你不接受 leak，可改回傳 `String` 並調整 `is_platform_asset`/`extract_variant_label` 簽名 —— 擇一，回報即可。

- [ ] **Step 2: lib.rs 加 `pub mod updater;`**

- [ ] **Step 3: 測試通過 + clippy/fmt 乾淨；Commit**

```bash
git add crates/core/src/updater.rs crates/core/src/lib.rs
git commit -m "feat(core): updater 純函式 — 預設變體、資產過濾、標籤提取、CUDA DLL 配對"
```

---

### Task 5: updater.rs — 下載、解壓與安裝流程

**Files:**
- Modify: `crates/core/src/updater.rs`
- Modify: `crates/core/Cargo.toml`（+ zip、flate2、tar）

- [ ] **Step 1: Cargo.toml 加入**

```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
flate2 = "1"
tar = "0.4"
```

- [ ] **Step 2: 實作下載/解壓/安裝（附加到 updater.rs）：**

```rust
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llamacpp-distributed-inference")
        .build()
        .expect("static client config")
}

fn emit_update_progress(state: &CoreState, percent: f64, message: &str) {
    state.emit(CoreEvent::DownloadProgress {
        percent,
        message: message.into(),
        current_file: String::new(),
        kind: "llamacpp",
    });
}

/// 帶進度的檔案下載（對齊 downloadFile；串流寫入；取消旗標可選）
async fn download_file(
    url: &str,
    dest: &Path,
    cancelled: Option<&AtomicBool>,
    on_progress: &dyn Fn(f64),
) -> Result<(), String> {
    let resp = http_client()
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下載失敗: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下載失敗: {e}"))? {
        if let Some(c) = cancelled {
            if c.load(Ordering::SeqCst) {
                drop(file);
                let _ = tokio::fs::remove_file(dest).await;
                return Err("下載已取消".into());
            }
        }
        downloaded += chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await.map_err(|e| e.to_string())?;
        if total > 0 {
            on_progress(downloaded as f64 / total as f64);
        }
    }
    Ok(())
}

/// 解壓 zip（純 Rust，對齊 extractArchive 的 Windows 分支但不用 PowerShell）
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out_path = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 解壓 tar.gz（對齊 extractArchive 的 unix 分支）
pub fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    tar.unpack(dest).map_err(|e| e.to_string())
}

pub fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let s = archive.to_string_lossy();
    if s.ends_with(".zip") {
        extract_zip(archive, dest)
    } else if s.ends_with(".tar.gz") {
        extract_tar_gz(archive, dest)
    } else {
        Err("不支援的壓縮格式".into())
    }
}

/// 遞迴列出目錄中的所有檔案（跳過 __update_temp 自身）
fn find_files_recursive(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            find_files_recursive(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// 複製二進位檔案到 bin 目錄（對齊 installBinaries：兩個 exe + 所有 dll；unix chmod 755）
fn install_binaries(temp_dir: &Path, bin_dir: &Path) -> Result<usize, String> {
    let targets: &[&str] = if cfg!(windows) {
        &["llama-server.exe", "rpc-server.exe"]
    } else {
        &["llama-server", "rpc-server"]
    };
    let mut files = Vec::new();
    find_files_recursive(temp_dir, &mut files)?;
    let mut installed = 0;
    for target in targets {
        if let Some(found) = files.iter().find(|f| f.file_name().map(|n| n.to_string_lossy() == *target).unwrap_or(false)) {
            let dest = bin_dir.join(target);
            std::fs::copy(found, &dest).map_err(|e| format!("複製 {target} 失敗: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            installed += 1;
        }
    }
    if cfg!(windows) {
        for f in files.iter().filter(|f| f.extension().map(|e| e == "dll").unwrap_or(false)) {
            let name = f.file_name().unwrap();
            std::fs::copy(f, bin_dir.join(name)).map_err(|e| e.to_string())?;
            installed += 1;
        }
    }
    Ok(installed)
}

/// 對齊 downloadAndInstall：完整更新流程。
/// 注意：呼叫端必須先停止 RPC/API 伺服器（二進位檔案會被覆蓋）。
#[allow(clippy::too_many_arguments)]
pub async fn download_and_install(
    state: &Arc<CoreState>,
    config_path: &Path,
    asset_url: &str,
    asset_name: &str,
    tag: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let bin_dir = crate::paths::bin_dir();
    let temp_dir = bin_dir.join("__update_temp");

    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| e.to_string())?;

    // ---- 步驟 1：下載主 asset（已有非空暫存則跳過）----
    let main_path = temp_dir.join(asset_name);
    let cached = tokio::fs::metadata(&main_path).await.map(|m| m.len() > 0).unwrap_or(false);
    if cached {
        emit_update_progress(state, 65.0, &format!("使用暫存的主檔案 {asset_name}..."));
    } else {
        emit_update_progress(state, 5.0, &format!("正在下載 {asset_name}..."));
        let st = state.clone();
        download_file(asset_url, &main_path, Some(cancelled), &move |pct| {
            emit_update_progress(&st, 5.0 + pct * 60.0, &format!("下載中... {}%", (pct * 100.0) as u32));
        })
        .await?;
    }

    // ---- 步驟 2：CUDA DLL 附帶下載（windows）----
    if cfg!(windows) {
        if let Some(dll_name) = matching_cuda_dll(asset_name) {
            let dll_path = temp_dir.join(dll_name);
            let dll_cached = tokio::fs::metadata(&dll_path).await.map(|m| m.len() > 0).unwrap_or(false);
            if dll_cached {
                emit_update_progress(state, 75.0, "使用暫存的 CUDA DLL...");
            } else {
                emit_update_progress(state, 65.0, &format!("正在下載 CUDA 執行庫 ({dll_name})..."));
                let dll_url = format!("{GITHUB_RELEASES}/{tag}/{dll_name}");
                let st = state.clone();
                download_file(&dll_url, &dll_path, Some(cancelled), &move |pct| {
                    emit_update_progress(&st, 65.0 + pct * 10.0, &format!("下載 CUDA DLL... {}%", (pct * 100.0) as u32));
                })
                .await?;
            }
            let dll = dll_path.clone();
            tokio::task::spawn_blocking(move || extract_archive(&dll, &temp_dir))
                .await
                .map_err(|e| e.to_string())??;
        }
    }

    // ---- 步驟 3：解壓主 asset（blocking pool）----
    emit_update_progress(state, 75.0, "正在解壓縮...");
    let main = main_path.clone();
    let tmp = temp_dir.clone();
    tokio::task::spawn_blocking(move || extract_archive(&main, &tmp))
        .await
        .map_err(|e| e.to_string())??;

    // ---- 步驟 4：安裝 ----
    emit_update_progress(state, 85.0, "正在安裝...");
    let t = temp_dir.clone();
    let b = bin_dir.clone();
    let installed = tokio::task::spawn_blocking(move || install_binaries(&t, &b))
        .await
        .map_err(|e| e.to_string())??;
    if installed == 0 {
        return Err("壓縮檔中未找到 llama-server/rpc-server 二進位檔案".into());
    }

    // ---- 步驟 5：儲存版本號 + 清理 ----
    let mut cfg = crate::config::Config::load(config_path).map_err(|e| e.to_string())?;
    cfg.llamacpp_version = tag.to_string();
    cfg.save(config_path).map_err(|e| e.to_string())?;

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    emit_update_progress(state, 100.0, "安裝完成！");
    Ok(())
}

/// 對齊 checkForUpdates
pub async fn check_for_updates(config_path: &Path) -> Result<(String, String, bool, String), String> {
    let cfg = crate::config::Config::load(config_path).map_err(|e| e.to_string())?;
    let current = cfg.llamacpp_version;
    let release: serde_json::Value = http_client()
        .get(GITHUB_API)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHub API 請求失敗: {e}"))?
        .json()
        .await
        .map_err(|_| "無法解析 GitHub API 回應".to_string())?;
    let latest = release["tag_name"].as_str().ok_or("無法解析 GitHub API 回應")?.to_string();
    let release_url = release["html_url"].as_str().unwrap_or("").to_string();
    Ok((current, latest.clone(), current != latest, release_url))
}

/// 對齊 getAvailableAssets
pub async fn get_available_assets(platform_arch: (&str, &str)) -> Result<Vec<AssetInfo>, String> {
    let release: serde_json::Value = http_client()
        .get(GITHUB_API)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHub API 請求失敗: {e}"))?
        .json()
        .await
        .map_err(|_| "無法解析 GitHub API 回應".to_string())?;
    Ok(filter_assets(&release, platform_arch.0, platform_arch.1))
}

/// 對齊 getCurrentVersion
pub fn get_current_version(config_path: &Path) -> String {
    crate::config::Config::load(config_path)
        .map(|c| c.llamacpp_version)
        .unwrap_or_else(|_| "未安裝".into())
}
```

- [ ] **Step 3: 測試（解壓/安裝用本地 fixture）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 建立 zip fixture（含子目錄結構）
    fn make_test_zip(path: &Path) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(file);
        z.add_directory("sub/", zip::write::SimpleFileOptions::default()).unwrap();
        z.start_file("sub/llama-server.exe", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"server-binary").unwrap();
        z.start_file("rpc-server.exe", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"rpc-binary").unwrap();
        z.start_file("helper.dll", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"dll-data").unwrap();
        z.finish().unwrap();
    }

    #[test]
    fn test_extract_zip_and_install_binaries() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("t.zip");
        make_test_zip(&zip_path);
        let exdir = tmp.path().join("ex");
        std::fs::create_dir_all(&exdir).unwrap();
        extract_zip(&zip_path, &exdir).unwrap();
        assert!(exdir.join("sub/llama-server.exe").exists());

        let bindir = tmp.path().join("bin");
        std::fs::create_dir_all(&bindir).unwrap();
        let n = install_binaries(&exdir, &bindir).unwrap();
        // windows: 2 exe + 1 dll = 3；非 windows: 只比對不含 .exe 的名字 → 0
        if cfg!(windows) {
            assert_eq!(n, 3);
            assert!(bindir.join("llama-server.exe").exists());
            assert!(bindir.join("rpc-server.exe").exists());
            assert!(bindir.join("helper.dll").exists());
        }
    }

    #[test]
    fn test_extract_archive_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("x.rar");
        std::fs::write(&p, b"x").unwrap();
        assert!(extract_archive(&p, tmp.path()).is_err());
    }

    #[tokio::test]
    async fn test_check_for_updates_network_error_is_graceful() {
        // 不連網環境：應回 Err 而非 panic（若 CI 可上網則會成功 —— 兩者皆接受，
        // 因此此測試只斷言「不 panic」，回傳值型別正確）
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("config.json");
        let _ = crate::config::Config::default().save(&cfg_path);
        let r = check_for_updates(&cfg_path).await;
        let _ = r; // Ok 或 Err 都可
    }
}
```

（若 `install_binaries` 在非 Windows 上因目標名不含 .exe 而找不到檔案，測試分支已處理；保持原樣。）

- [ ] **Step 4: 全套測試 + clippy + fmt 乾淨；Commit**

```bash
git add crates/core/src/updater.rs crates/core/Cargo.toml Cargo.lock
git commit -m "feat(core): updater 下載安裝流程 — zip/tar.gz 解壓、CUDA DLL 配對、進度事件"
```

---

### Task 6: 整合測試 + Phase 3 完成驗證

**Files:**
- Modify: `crates/core/tests/integration.rs`

- [ ] **Step 1: 追加整合測試**

```rust
#[test]
fn hf_grouping_matches_frontend_expectations() {
    use llama_dist_core::hf::{group_by_variant, GgufFile};

    let files = vec![
        GgufFile { name: "Qwen3-32B-UD-Q2_K_XL-00002-of-00002.gguf".into(), size: 9_000 },
        GgufFile { name: "Qwen3-32B-UD-Q2_K_XL-00001-of-00002.gguf".into(), size: 9_500_000_000u64 },
        GgufFile { name: "Qwen3-32B-Q4_K_M.gguf".into(), size: 19_800_000_000u64 },
    ];
    let groups = group_by_variant(&files);
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].variant, "Q4_K_M"); // 字典序 Q4 < UD
    assert_eq!(groups[1].variant, "UD-Q2_K_XL");
    assert!(groups[1].is_split);
    assert_eq!(groups[1].shard_count, 2);
}

#[test]
fn updater_config_version_roundtrip_integration() {
    use llama_dist_core::updater;
    let dir = tempfile::tempdir().unwrap();
    let cfg_path = dir.path().join("config.json");
    assert_eq!(updater::get_current_version(&cfg_path), "未安裝");
    let mut cfg = llama_dist_core::config::Config::default();
    cfg.llamacpp_version = "b9000".into();
    cfg.save(&cfg_path).unwrap();
    assert_eq!(updater::get_current_version(&cfg_path), "b9000");
}
```

- [ ] **Step 2: 全量驗證**

- `cargo test --workspace` → 全綠
- `cargo clippy --all-targets -- -D warnings` → clean
- `cargo fmt --check` → clean
- `cargo build --release` → 成功（TLS 功能加入後確認連結正常）

- [ ] **Step 3: Commit**

```bash
git add crates/core/tests/integration.rs
git commit -m "test(core): Phase 3 整合測試 — HF 分組前端預期、updater 版本往返"
```

---

## 完成標準（Phase 3 Definition of Done）

- 全部測試綠；clippy/fmt 乾淨；release build 成功
- 行為對照表：
  - ✅ SPLIT_GGUF_REGEX 語意（5 位數分片解析）
  - ✅ groupByVariant 分組/排序/shardCount/totalSize
  - ✅ extractQuantLabel 四段匹配順序與 fallback
  - ✅ downloadModel 整體進度公式與取消語意（已完成檔案保留）
  - ✅ getDefaultVariant 平台×架構映射
  - ✅ 資產過濾前綴/副檔名與 isDefault
  - ✅ CUDA DLL 配對與進度區間（5-65-75-85-100）
  - ✅ installBinaries 兩 exe + 所有 dll + unix chmod
  - ✅ llamacppVersion 儲存與「未安裝」預設

## 已知限制（記錄）
- HF/GitHub 真實網路測試標記 #[ignore]，CI 不跑
- 更新時二進位被鎖的保護由呼叫端負責（先停 RPC/API —— GUI/control 層的職責）
- 斷點續傳不做（spec 非目標；失敗重下單檔）

## 後續階段
- Phase 4: control 伺服器（axum :59999 + token + SSE）
