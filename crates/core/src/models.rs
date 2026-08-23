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
    if files.contains(&with_ext) {
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
    files
        .iter()
        .find(|f| {
            let fl = f.to_lowercase();
            let stem = fl.strip_suffix(".gguf").unwrap_or(&fl);
            fl.contains(&lower) || lower.contains(stem)
        })
        .cloned()
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
                model_size as f64 / GB as f64,
                limits.max_limit_gb
            ));
        }
    }
    if model_size > limits.total_mem.saturating_sub(SYSTEM_RESERVE) {
        return Err(format!(
            "模型大小 ({:.2} GB) 超出系統總記憶體限制 ({:.2} GB)。",
            model_size as f64 / GB as f64,
            limits.total_mem as f64 / GB as f64
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
        let total: u64 = 8 * GB;
        let err = check_memory(
            9 * GB,
            0,
            MemoryLimits {
                total_mem: total,
                free_mem: 4 * GB,
                max_limit_gb: 0,
            },
        )
        .unwrap_err();
        assert!(err.contains("超出系統"));
    }

    #[test]
    fn test_memory_max_limit_gb() {
        let limits = MemoryLimits {
            total_mem: 32 * GB,
            free_mem: 16 * GB,
            max_limit_gb: 10,
        };
        let err = check_memory(11u64 * GB, 0, limits).unwrap_err();
        assert!(err.contains("上限"));
    }

    #[test]
    fn test_memory_warning_only_when_free_low() {
        let limits = MemoryLimits {
            total_mem: 16 * GB,
            free_mem: 2 * GB,
            max_limit_gb: 0,
        };
        let (warn, ok) = check_memory(6 * GB, 0, limits).unwrap();
        assert!(ok);
        assert!(warn.is_some());
    }

    #[test]
    fn test_scan_or_init_creates_readme() {
        let dir = tempfile::tempdir().unwrap();
        let mdir = dir.path().join("models");
        let files = scan_or_init_models_dir(&mdir).unwrap();
        assert!(files.is_empty());
        assert!(mdir.join("README.md").exists());
    }

    #[test]
    fn test_scan_lists_and_sorts_gguf() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.gguf"), b"x").unwrap();
        std::fs::write(dir.path().join("a.gguf"), b"x").unwrap();
        std::fs::write(dir.path().join("README.md"), b"x").unwrap();
        let files = scan_or_init_models_dir(dir.path()).unwrap();
        assert_eq!(files, vec!["a.gguf".to_string(), "b.gguf".to_string()]);
    }
}
