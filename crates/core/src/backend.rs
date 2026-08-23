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

    // Speculative Decoding
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

/// 找尋自 start 起的第一個空閒埠（對齊 getFreePort）
pub async fn get_free_port(start: u16) -> u16 {
    for port in start..start.saturating_add(500) {
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
        if client
            .get(&url)
            .send()
            .await
            .is_ok_and(|r| r.status() == reqwest::StatusCode::OK)
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("等待推理引擎啟動超時。".into())
}

/// 系統記憶體查詢（Windows: CIM；Linux: /proc/meminfo；macOS: sysctl）
fn sys_total_mem() -> Option<u64> {
    memory_info().map(|(t, _)| t)
}
fn sys_free_mem() -> Option<u64> {
    memory_info().map(|(_, f)| f)
}
fn memory_info() -> Option<(u64, u64)> {
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
        let get = |key: &str| -> Option<u64> {
            txt.lines()
                .find(|l| l.starts_with(key))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024)
        };
        Some((get("MemTotal:")?, get("MemAvailable:")?))
    }
    #[cfg(windows)]
    {
        let ps_cmd = concat!(
            "$os=Get-CimInstance Win32_OperatingSystem; ",
            "\"$($os.TotalVisibleMemorySize),$($os.FreePhysicalMemory)\""
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", ps_cmd])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let mut it = s.trim().split(',');
        let total_kb: u64 = it.next()?.trim().parse().ok()?;
        let free_kb: u64 = it.next()?.trim().parse().ok()?;
        Some((total_kb * 1024, free_kb * 1024))
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        let total: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        Some((total, total / 2)) // macOS 無簡易 free；保守估半數
    }
    #[cfg(not(any(windows, unix)))]
    {
        None
    }
}

/// 目前運行中的 backend handle
pub struct BackendHandle {
    pub model_name: String,
    pub port: u16,
    child: Mutex<tokio::process::Child>,
}

impl BackendHandle {
    pub async fn kill(&self) {
        let mut c = self.child.lock().await;
        let _ = c.start_kill();
    }
}

/// llama-server backend 管理器
pub struct BackendManager {
    state: Arc<CoreState>,
    server_path: PathBuf,
    models_dir: PathBuf,
    current: Mutex<Option<Arc<BackendHandle>>>,
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
        self.current
            .lock()
            .await
            .as_ref()
            .map(|h| h.model_name.clone())
    }

    pub async fn active_port(&self) -> Option<u16> {
        self.current.lock().await.as_ref().map(|h| h.port)
    }

    pub async fn is_loaded(&self) -> bool {
        self.current.lock().await.is_some()
    }

    /// 卸載目前 backend（proxy 保持運行）
    pub async fn stop_current(&self) {
        let handle = self.current.lock().await.take();
        if let Some(h) = handle {
            h.kill().await;
        }
    }

    /// 載入模型（含切換：先停舊、等 1 秒、再起新）——對齊 loadModelBackend。
    ///
    /// # Concurrency
    /// 此方法內部**未**序列化：並行呼叫可能導致連埠衝突或孤兒進程。
    /// 呼叫端（ApiManager / Tauri commands）必須自行確保同一時間只有一個載入流程。
    pub async fn load_model(&self, model_name: &str, opts: &ServerOptions) -> Result<(), String> {
        use crate::models::{check_memory, MemoryLimits};

        if !self.server_path.exists() {
            return Err("尚未安裝 llama.cpp 核心，請先更新安裝。".into());
        }
        let model_path = self.models_dir.join(model_name);
        if !model_path.exists() {
            return Err(format!("找不到模型檔案: {model_name}"));
        }
        let model_size = std::fs::metadata(&model_path).map_err(|e| e.to_string())?.len();

        // 記憶體硬性檢查
        let running_size = self
            .active_model()
            .await
            .and_then(|m| std::fs::metadata(self.models_dir.join(&m)).ok())
            .map(|m| m.len());
        // 查詢可能涉及子進程/檔案 IO，放到 blocking pool 避免卡住 tokio worker
        let (limits_total, limits_free) = {
            let total = tokio::task::spawn_blocking(sys_total_mem).await.unwrap_or(None);
            let free = tokio::task::spawn_blocking(sys_free_mem).await.unwrap_or(None);
            match (total, free) {
                (Some(t), Some(f)) => (t, f),
                _ => return Err("無法取得系統記憶體資訊。".into()),
            }
        };
        let (warning, _) = check_memory(
            model_size,
            running_size.unwrap_or(0),
            MemoryLimits {
                total_mem: limits_total,
                free_mem: limits_free,
                max_limit_gb: opts.max_memory_limit,
            },
        )?;

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
            self.models_dir
                .join(&opts.draft_model)
                .to_string_lossy()
                .to_string()
        } else {
            String::new()
        };
        let args = build_backend_args(&model_path.to_string_lossy(), port, &draft_path, opts);

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

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
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

        // 等待 /health 就緒；進程先死則清理並報錯（wait 為 cancel-safe，可安全用於 select）
        let health = tokio::select! {
            r = wait_health(port) => r,
            status = child.wait() => {
                let code = status.map_err(|e| e.to_string())?;
                return Err(format!("推理引擎啟動失敗，退出代碼 {code}"));
            }
        };
        if let Err(e) = health {
            let _ = child.start_kill();
            return Err(e);
        }

        *self.current.lock().await = Some(Arc::new(BackendHandle {
            model_name: model_name.into(),
            port,
            child: Mutex::new(child),
        }));

        self.state.emit(CoreEvent::ApiServerLog(format!(
            "[系統] 模型 \"{model_name}\" 載入完成，推理引擎已就緒。\n"
        )));
        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: format!("運行中 (已載入: {model_name})"),
            loaded_model: Some(model_name.into()),
        });
        Ok(())
    }
}



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
        let args = build_backend_args("/models/qwen.gguf", 8081, "/models/draft-q4.gguf", &opts());
        let expect: Vec<String> = [
            "-m", "/models/qwen.gguf", "--host", "127.0.0.1", "--port", "8081",
            "--api-key", "sk-1",
            "--rpc", "192.168.1.10:50052",
            "-ngl", "33", "-np", "4", "--ctx-size", "8192",
            "-fa", "-ctk", "q8_0", "-t", "8", "--device", "0",
            "-md", "/models/draft-q4.gguf", "-ngld", "99",
            "--draft-max", "16", "--draft-min", "5", "--draft-p-min", "0.8",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expect); // -ctv=f16 不出現
    }

    #[test]
    fn test_args_minimal() {
        let o = ServerOptions::default();
        let args = build_backend_args("/m.gguf", 9000, "", &o);
        assert_eq!(
            args,
            vec!["-m", "/m.gguf", "--host", "127.0.0.1", "--port", "9000"]
        );
    }

    #[test]
    fn test_rpc_filter_local() {
        let mut o = opts();
        o.rpc_nodes = vec!["localhost".into(), "127.0.0.1".into()];
        let args = build_backend_args("/m.gguf", 9000, "", &o);
        assert!(!args.contains(&"--rpc".to_string()));
    }

    #[test]
    fn test_spec_disabled_no_draft_args() {
        let mut o = opts();
        o.spec_enabled = false;
        let args = build_backend_args("/m.gguf", 9000, "", &o);
        assert!(!args.contains(&"-md".to_string()));
    }

    #[tokio::test]
    async fn test_get_free_port_finds_open() {
        let port = get_free_port(20000).await;
        assert!((20000..20500).contains(&port));
    }

    #[tokio::test]
    async fn test_load_model_missing_binary_errors() {
        let state = CoreState::new_for_test();
        let mgr = BackendManager::new(
            state.clone(),
            PathBuf::from("Z:/nope/llama-server.exe"),
            std::env::temp_dir(),
        );
        let err = mgr
            .load_model("x.gguf", &ServerOptions::default())
            .await
            .unwrap_err();
        assert!(err.contains("尚未安裝"));
    }
}
