//! Hugging Face 模型 API 與下載（對齊 Electron `src/main/hf-downloader.js`）
//!
//! 包含檔名解析純函式、Repo 元資訊查詢、GGUF 變體分組，
//! 以及串流下載（整體進度事件 + 取消支援）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Serialize};

use crate::state::CoreState;
use crate::CoreEvent;

/// Hugging Face Models API 端點
pub const HF_API_BASE: &str = "https://huggingface.co/api/models";

/// Hugging Face 檔案解析端點
pub const HF_RESOLVE_BASE: &str = "https://huggingface.co";

/// 分割 GGUF 檔名正則：`<BaseName>-<ShardNum>-of-<ShardTotal>.gguf`
/// （JS `\d` 僅匹配 ASCII 數字，改寫為 `[0-9]` 保持語意一致；
/// `.+` 貪婪匹配行為與 JS 正則相同）
static SPLIT_GGUF_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^(.+)-([0-9]{5})-of-([0-9]{5})\.gguf$").expect("valid regex")
});

/// 量化標籤匹配順序（對齊 quantPatterns；`(?i)` 對應 JS `/i`，
/// JS `\d`/`\w` 分別以 `[0-9]`/`[0-9A-Za-z_]` 明確改寫）
static QUANT_PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
    [
        r"[_-](UD[_-]Q[0-9]+[_A-Z]*[0-9A-Za-z_]*)",
        r"[_-](IQ[0-9]+[_A-Z]*[0-9A-Za-z_]*)",
        r"[_-](Q[0-9]+[_A-Z]*[0-9A-Za-z_]*)",
        r"[_-](F16|F32|BF16)",
    ]
    .iter()
    .map(|p| regex::Regex::new(&format!("(?i){p}")).expect("valid regex"))
    .collect()
});

/// Repo 內單一 GGUF 檔案（對齊 listGGUFFiles 的 siblings 映射）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GgufFile {
    pub name: String,
    pub size: u64,
}

/// 量化變體分組（camelCase 序列化對齊前端）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantGroup {
    pub variant: String,
    pub files: Vec<GgufFile>,
    pub total_size: u64,
    pub shard_count: usize,
    pub is_split: bool,
}

/// 解析分割 GGUF 檔名的 BaseName（對齊 `/^(.+)-(\d{5})-of-(\d{5})\.gguf$/`）
pub fn split_gguf_base(name: &str) -> Option<String> {
    SPLIT_GGUF_REGEX.captures(name).map(|c| c[1].to_string())
}

/// 從 BaseName 提取量化標籤（對齊 extractQuantLabel 四段匹配順序：
/// UD-Q → IQ → Q → F16/F32/BF16）；結果轉大寫，
/// 無匹配時取最後路徑段（超過 40 字元保留尾 40 字元）
pub fn extract_quant_label(base_name: &str) -> String {
    for pattern in QUANT_PATTERNS.iter() {
        if let Some(c) = pattern.captures(base_name) {
            return c[1].to_uppercase();
        }
    }
    // 未匹配量化標籤：回退至最後路徑段，過長則截尾 40 字元
    let name = match base_name.rfind('/') {
        Some(idx) => &base_name[idx + 1..],
        None => base_name,
    };
    let char_count = name.chars().count();
    if char_count > 40 {
        name.chars().skip(char_count - 40).collect()
    } else {
        name.to_string()
    }
}

/// 將 GGUF 檔案按量化變體分組（對齊 groupByVariant）
///
/// - 分割檔以 BaseName 歸組（isSplit=true），組內依檔名排序
/// - 單檔各自成組（isSplit=false）
/// - 輸出按 variant 字典序排序（stable sort，同 variant 保持插入順序）
pub fn group_by_variant(files: &[GgufFile]) -> Vec<VariantGroup> {
    struct Acc {
        key: String,
        variant: String,
        files: Vec<GgufFile>,
        is_split: bool,
    }

    // 以 Vec 維護插入順序（對齊 JS Map 的迭代語意；檔案數量少，線性查找即可）
    let mut accs: Vec<Acc> = Vec::new();

    for file in files {
        let (key, base, is_split) = match split_gguf_base(&file.name) {
            // 分割檔案：BaseName 作為 group key
            Some(base) => (base.clone(), base, true),
            // 單檔 GGUF：完整檔名作為 group key
            None => {
                let base = file.name.strip_suffix(".gguf").unwrap_or(&file.name);
                (file.name.clone(), base.to_string(), false)
            }
        };

        if let Some(acc) = accs.iter_mut().find(|acc| acc.key == key) {
            acc.files.push(file.clone());
        } else {
            accs.push(Acc {
                variant: extract_quant_label(&base),
                key,
                files: vec![file.clone()],
                is_split,
            });
        }
    }

    let mut out: Vec<VariantGroup> = accs
        .into_iter()
        .map(|acc| VariantGroup {
            total_size: acc.files.iter().map(|f| f.size).sum(),
            shard_count: acc.files.len(),
            variant: acc.variant,
            files: acc.files,
            is_split: acc.is_split,
        })
        .collect();

    // 排序每個分割組內的檔案（JS localeCompare；分片名稱為 ASCII，
    // 位元組比較結果等價）
    for group in out.iter_mut().filter(|g| g.is_split) {
        group.files.sort_by(|a, b| a.name.cmp(&b.name));
    }

    // 輸出按 variant 排序
    out.sort_by(|a, b| a.variant.cmp(&b.variant));
    out
}

// ==================== 網路層：API 查詢與下載 ====================

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llamacpp-distributed-inference")
        .build()
        .expect("static client config")
}

/// Repo 元資訊（對齊 searchRepo 回傳）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: String,
    pub author: String,
    pub model_id: String,
    pub downloads: u64,
    pub tags: Vec<String>,
}

/// 搜尋 HF Repo 並回傳元資訊（對齊 searchRepo）
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
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// 列出 Repo 內 GGUF 檔案並按量化變體分組（對齊 listGGUFFiles）
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
                .filter_map(|s| {
                    let name = s["rfilename"].as_str()?;
                    if !name.ends_with(".gguf") {
                        return None;
                    }
                    Some(GgufFile {
                        name: name.to_string(),
                        size: s["size"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(group_by_variant(&files))
}

/// 活動下載取消旗標（全域；與 cancelDownload 對應）
pub static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 取消正在進行的下載（對齊 cancelDownload）
pub fn cancel_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

fn emit_progress(state: &CoreState, percent: f64, message: &str, current_file: &str) {
    state.emit(CoreEvent::DownloadProgress {
        percent,
        message: message.into(),
        current_file: current_file.into(),
        kind: "hf",
    });
}

/// 下載單檔（串流寫入 dest；回報 0.0~1.0 檔內進度；
/// 取消時刪除暫存並回 Err("下載已取消")）
async fn download_file_with_progress(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancelled: &AtomicBool,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

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
        if cancelled.load(Ordering::SeqCst) {
            file.flush().await.ok();
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err("下載已取消".into());
        }
        downloaded += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("寫入失敗: {e}"))?;
        if total > 0 {
            on_progress(downloaded as f64 / total as f64);
        }
    }
    Ok(())
}

/// 下載選定的模型檔案到指定目錄（對齊 downloadModel）：
/// 循序下載多檔 + 整體進度事件（kind="hf"）+ 取消支援。
/// 失敗/取消時已完成檔案保留，回傳 Err(訊息)。
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
        if cancelled.load(Ordering::SeqCst) {
            return Err("下載已取消".into());
        }
        let url = format!("{HF_RESOLVE_BASE}/{repo_id}/resolve/main/{file_name}");
        let dest = models_path.join(file_name);

        emit_progress(
            state,
            i as f64 / total as f64 * 100.0,
            &format!("開始下載 {file_name} ({}/{})", i + 1, total),
            file_name,
        );

        let st_pct = state.clone();
        let fname = file_name.clone();
        let idx = i;
        let progress_cb = move |pct: f64| {
            let overall = (idx as f64 + pct) / total as f64 * 100.0;
            emit_progress(
                &st_pct,
                overall,
                &format!(
                    "下載中 ({}/{})... {}%",
                    idx + 1,
                    total,
                    (pct * 100.0) as u32
                ),
                &fname,
            );
        };
        download_file_with_progress(&http, &url, &dest, cancelled, &progress_cb).await?;

        downloaded_files.push(file_name.clone());
    }

    Ok(downloaded_files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_gguf_base() {
        assert_eq!(
            split_gguf_base("Model-00001-of-00005.gguf"),
            Some("Model".into())
        );
        assert_eq!(
            split_gguf_base("Qwen3-32B-Q4_K_M-00003-of-00007.gguf"),
            Some("Qwen3-32B-Q4_K_M".into())
        );
        assert_eq!(split_gguf_base("plain.gguf"), None);
        assert_eq!(split_gguf_base("Model-1-of-5.gguf"), None); // 位數不足
        assert_eq!(split_gguf_base("Model-00001-of-0000X.gguf"), None); // 非數字
        assert_eq!(split_gguf_base("-00001-of-00002.gguf"), None); // 空 base
    }

    #[test]
    fn test_extract_quant_label() {
        assert_eq!(extract_quant_label("Qwen3-32B-Q4_K_M"), "Q4_K_M");
        assert_eq!(extract_quant_label("Qwen3-32B-UD-Q8_K_XL"), "UD-Q8_K_XL");
        assert_eq!(extract_quant_label("model_IQ4_XS"), "IQ4_XS");
        assert_eq!(extract_quant_label("model-f16"), "F16");
        assert_eq!(extract_quant_label("nomatch"), "nomatch");
    }

    #[test]
    fn test_extract_quant_label_edge_cases() {
        // UD 底線變體
        assert_eq!(extract_quant_label("M-UD_Q8_K_XL"), "UD_Q8_K_XL");
        // BF16 與大小寫無關
        assert_eq!(extract_quant_label("model-bf16"), "BF16");
        assert_eq!(extract_quant_label("m_q4_k_m"), "Q4_K_M");
        // 無匹配且最後路徑段過長：保留尾 40 字元
        let long = format!("some/repo/{}", "x".repeat(50));
        assert_eq!(extract_quant_label(&long), "x".repeat(40));
    }

    #[test]
    fn test_group_by_variant() {
        let files = vec![
            GgufFile {
                name: "M-Q8_0.gguf".into(),
                size: 100,
            },
            GgufFile {
                name: "M-Q4_K_M-00002-of-00002.gguf".into(),
                size: 40,
            },
            GgufFile {
                name: "M-Q4_K_M-00001-of-00002.gguf".into(),
                size: 50,
            },
        ];
        let groups = group_by_variant(&files);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].variant, "Q4_K_M"); // 字典序 Q4 < Q8
        assert!(groups[0].is_split);
        assert_eq!(groups[0].shard_count, 2);
        assert_eq!(groups[0].total_size, 90);
        assert_eq!(
            groups[0].files[0].name,
            "M-Q4_K_M-00001-of-00002.gguf" // 分片排序
        );
        assert_eq!(groups[1].variant, "Q8_0");
        assert!(!groups[1].is_split);
    }

    #[test]
    fn test_variant_group_serializes_camel_case() {
        let group = VariantGroup {
            variant: "Q8_0".into(),
            files: vec![GgufFile {
                name: "M-Q8_0.gguf".into(),
                size: 5,
            }],
            total_size: 5,
            shard_count: 1,
            is_split: false,
        };
        let json = serde_json::to_string(&group).unwrap();
        assert!(json.contains(r#""totalSize":5"#));
        assert!(json.contains(r#""shardCount":1"#));
        assert!(json.contains(r#""isSplit":false"#));
    }

    #[tokio::test]
    async fn test_cancel_flag_skips_download() {
        let state = CoreState::new_for_test();
        let dir = tempfile::tempdir().unwrap();
        DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
        let r = download_model(
            &state,
            "any/repo",
            &["a.gguf".to_string()],
            dir.path(),
            &DOWNLOAD_CANCELLED,
        )
        .await;
        DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst); // 還原，避免影響其他測試
        assert_eq!(r.unwrap_err(), "下載已取消");
    }

    #[tokio::test]
    async fn test_download_file_connect_error() {
        let http = client();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f.bin");
        let flag = AtomicBool::new(false);
        let r = download_file_with_progress(
            &http,
            "http://127.0.0.1:1/unreachable", // 保留埠，必然連線失敗
            &dest,
            &flag,
            &|_| {},
        )
        .await;
        assert!(r.is_err());
        assert!(!dest.exists());
    }

    /// 本地 HTTP 伺服器模擬大檔下載：先送一小段、停頓後續送其餘資料，
    /// 客戶端在第一次進度回呼時置取消旗標，
    /// 驗證回傳「下載已取消」且暫存檔已刪除。
    #[tokio::test]
    async fn test_cancel_midstream_deletes_partial() {
        use std::io::Write;
        use std::time::Duration;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let chunk = [7u8; 4096];
        let server = std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
            stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
            // 先讀完客戶端的請求標頭（直到 \r\n\r\n）再回應，
            // 否則 hyper 客戶端會回報 UnexpectedMessage
            use std::io::Read;
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => return,
                }
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
                chunk.len() * 65
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            if stream.write_all(&chunk).is_err() {
                return;
            }
            let _ = stream.flush();
            // 停頓以確保客戶端至少收到兩次獨立的 chunk（取消檢查介於其間）
            std::thread::sleep(Duration::from_millis(200));
            for _ in 0..64 {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
            }
        });

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f.bin");
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_cb = cancelled.clone();
        let r = download_file_with_progress(
            &client(),
            &format!("http://{addr}/f.bin"),
            &dest,
            &cancelled,
            &move |_| cancelled_cb.store(true, Ordering::SeqCst),
        )
        .await;

        assert_eq!(r.unwrap_err(), "下載已取消");
        assert!(!dest.exists(), "部分下載的暫存檔應被刪除");
        let _ = server.join();
    }

    #[tokio::test]
    #[ignore = "requires network"]
    async fn test_search_repo_real() {
        let info = search_repo("ggml-org/gemma-3-1b-it-GGUF").await.unwrap();
        assert!(!info.id.is_empty());
    }
}
