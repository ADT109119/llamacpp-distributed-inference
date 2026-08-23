//! Hugging Face 模型檔名解析與變體分組（純函式）
//!
//! 移植自 Electron `src/main/hf-downloader.js` 的同步邏輯；
//! 網路請求（API 查詢、檔案下載）於後續任務加入。

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

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
}
