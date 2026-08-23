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

    /// 未安裝（binary 不存在）→ Err，呼叫端不啟動
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        self.start_with_args(["-H", "0.0.0.0", "-p", "50052", "-c"])
            .await
    }

    pub async fn start_with_args<I, S>(self: &Arc<Self>, args: I) -> Result<(), String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        if !self.binary_path.exists() {
            return Err("llama.cpp 尚未安裝".into());
        }
        // 單一鎖範圍：已運行檢查 + spawn + 存放，序列化 start/stop（避免 TOCTOU 與並發雙啟動）
        let mut rx = {
            let mut guard = self.child.lock().await;
            if guard.is_some() {
                // 已在跑：直接回報 running（對齊現行）
                self.state.emit(CoreEvent::RpcServerStatus(true));
                return Ok(());
            }

            let mut child = Command::new(&self.binary_path)
                .args(args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("Failed to start rpc-server: {e}"))?;

            // stdout/stderr 行化 → 事件
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
            crate::process::pipe_output(&mut child, tx);

            *guard = Some(child);
            rx
        };

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

        // 監看任務：自然退出時發 status false（被 stop 走時不重複發）
        let this2 = self.clone();
        tokio::spawn(async move {
            loop {
                let outcome = {
                    let mut g = this2.child.lock().await;
                    match g.as_mut() {
                        Some(c) => {
                            if matches!(c.try_wait(), Ok(Some(_))) {
                                *g = None;
                                Some("exited")
                            } else {
                                None
                            }
                        }
                        None => Some("taken"), // 已被 stop take 走（stop 已發事件）
                    }
                };
                match outcome {
                    Some("taken") => break,
                    Some("exited") => {
                        this2.state.emit(CoreEvent::RpcServerStatus(false));
                        break;
                    }
                    _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
                }
            }
        });

        // 對齊現行：延遲回報 running（若 2 秒內已退出/被停，不發過期 true）
        let this3 = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if this3.is_running().await {
                this3.state.emit(CoreEvent::RpcServerStatus(true));
            }
        });

        self.state.emit(CoreEvent::Log(
            crate::Subsystem::Sys,
            "RPC 伺服器已啟動".into(),
        ));
        Ok(())
    }

    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = *guard {
            // 進程可能已自然退出，kill 失敗可忽略
            let _ = child.start_kill(); // 同步送 SIGKILL/TerminateProcess
        }
        guard.take();
        self.state.emit(CoreEvent::RpcServerStatus(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_start_when_not_installed_fails() {
        let state = CoreState::new_for_test();
        let mgr = RpcManager::new(
            state,
            std::path::PathBuf::from("Z:/definitely-not-exist/rpc-server.exe"),
        );
        let result = mgr.start().await;
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_start_stop_real_process() {
        use std::time::Duration;
        let state = CoreState::new_for_test();
        let mgr = RpcManager::new(state, std::path::PathBuf::from("/bin/sleep"));
        // sleep 不是 rpc-server，但足以驗證 spawn/stop 生命周期
        mgr.start_with_args(["30"]).await.unwrap();
        assert!(mgr.is_running().await);
        mgr.stop().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!mgr.is_running().await);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_start_stop_windows_process() {
        use std::time::Duration;
        let state = CoreState::new_for_test();
        // ping -n 30 在 Windows 上會運行約 29 秒，足以驗證生命周期
        let mgr = RpcManager::new(
            state,
            std::path::PathBuf::from("C:\\Windows\\System32\\ping.exe"),
        );
        mgr.start_with_args(["-n", "30", "127.0.0.1"])
            .await
            .unwrap();
        assert!(mgr.is_running().await);
        mgr.stop().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!mgr.is_running().await);
    }
}
