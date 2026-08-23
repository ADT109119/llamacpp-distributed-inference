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
/// - 測試/CI 注入（LLAMA_DIST_PORTABLE）：直接採用該路徑
/// - 打包/portable 模式（偵測 exe 同層是否有 bin/<platform>/llama-server）：exe 所在目錄
/// - 開發模式：專案根
pub fn base_path() -> PathBuf {
    if let Ok(dir) = std::env::var("LLAMA_DIST_PORTABLE") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // portable 判斷：exe 目錄下存在 bin/<platform>/llama-server
            // （target/debug 等建置輸出目錄不可能出現此佈局）
            if dir
                .join("bin")
                .join(platform_id())
                .join(binary_file_name("llama-server"))
                .exists()
            {
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
        // 測試環境（無 LLAMA_DIST_PORTABLE、exe 在 target/debug/deps）下應回到專案根
        assert_eq!(base_path(), dev_root());
        assert!(dev_root().join("crates").join("core").exists());
    }

    #[test]
    fn test_portable_env_override() {
        let tmp = tempfile::tempdir().unwrap();
        // 建立可攜式佈局：<tmp>/bin/<platform>/llama-server(.exe)
        let bindir = tmp.path().join("bin").join(platform_id());
        std::fs::create_dir_all(&bindir).unwrap();
        std::fs::write(bindir.join(binary_file_name("llama-server")), b"x").unwrap();

        // 設定環境變數後 base_path 應直接採用該路徑
        std::env::set_var("LLAMA_DIST_PORTABLE", tmp.path());
        assert_eq!(base_path(), tmp.path());
        std::env::remove_var("LLAMA_DIST_PORTABLE");
    }

    #[test]
    fn test_bin_dir_shape() {
        let bd = bin_dir();
        assert!(bd.to_string_lossy().replace('\\', "/").ends_with(&format!("bin/{}", platform_id())));
    }
}
