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
/// - 打包/portable 模式（偵測 exe 同層是否有 bin/）：exe 所在目錄
/// - 開發模式：專案根
pub fn base_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // portable 判斷：exe 目錄下存在 bin/（NSIS portable 佈局）
            // 排除 cargo 測試輸出目錄（deps 等）誤判
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

/// 模型資料夾預設路徑（未自訂時）：dev → 專案根/models；portable → exe 目錄/models
pub fn default_models_path() -> PathBuf {
    base_path().join("models")
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
    fn test_dev_base_path_is_project_root() {
        // 在開發/測試環境下 base_path 應指到專案根
        let root = base_path();
        assert!(
            root.join("src").exists() || root.join(".git").exists() || root.join("crates").exists(),
            "base_path 應為專案根，實際: {root:?}"
        );
    }

    #[test]
    fn test_bin_dir_shape() {
        let bd = bin_dir();
        assert!(bd.to_string_lossy().replace('\\', "/").ends_with(&format!("bin/{}", platform_id())));
    }
}
