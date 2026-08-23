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
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(Box::new(e)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text)?;
        Ok(())
    }
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
        let path = PathBuf::from(dir.path()).join("sub").join("config.json");
        let cfg = Config {
            api_key: "sk-test".into(),
            ..Config::default()
        };
        cfg.save(&path).unwrap();
        let back = Config::load(&path).unwrap();
        assert_eq!(back.api_key, "sk-test");
    }

    #[test]
    fn test_load_unreadable_file_errors() {
        // 建立一個「目錄」當作檔案路徑 → 讀取必失敗（非 NotFound）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::create_dir(&path).unwrap();
        assert!(Config::load(&path).is_err());
    }
}
