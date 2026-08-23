use crate::backend::BackendManager;
use crate::config::ServerOptions;
use crate::proxy::ProxyServer;
use crate::state::CoreState;
use crate::CoreEvent;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify, watch};

/// 閒置逾時秒數（分鐘 → Duration；0 = 停用回 None）
pub fn idle_duration(minutes: u32) -> Option<Duration> {
    if minutes == 0 {
        None
    } else {
        Some(Duration::from_secs(minutes as u64 * 60))
    }
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
}

impl ApiManager {
    pub fn new(state: Arc<CoreState>, models_dir: PathBuf) -> Arc<Self> {
        let idle_notify = Arc::new(Notify::new());
        let backend = BackendManager::new(
            state.clone(),
            crate::paths::binary_path("llama-server"),
            models_dir.clone(),
        );
        let proxy = ProxyServer::new(
            state.clone(),
            backend.clone(),
            idle_notify.clone(),
            models_dir.clone(),
        );
        Arc::new(Self {
            state,
            backend,
            proxy,
            shutdown_txs: Mutex::new(Vec::new()),
            idle_notify,
            last_options: Arc::new(tokio::sync::RwLock::new(None)),
        })
    }

    /// 測試建構：指向不存在的二進位與暫存 models 目錄
    pub fn new_for_test(state: Arc<CoreState>) -> Arc<Self> {
        Self::new(state, std::env::temp_dir().join("llama-dist-test-models"))
    }

    pub fn backend(&self) -> &Arc<BackendManager> {
        &self.backend
    }

    pub fn proxy(&self) -> &Arc<ProxyServer> {
        &self.proxy
    }

    /// proxy 的模型清單快照刷新（下載模型後或手動重掃時呼叫）
    pub async fn refresh_models(&self) {
        self.proxy.refresh_models().await;
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
        tokio::spawn(async move {
            let _ = proxy.run(rx, opts).await;
        });

        // 閒置監看任務
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
                                        "[閒置管理] 偵測到已閒置 {} 分鐘，自動卸載模型 \"{m}\" 以釋放系統資源...\n",
                                        last.read().await.as_ref().map(|o| o.idle_timeout).unwrap_or(0)
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
        self.state.emit(CoreEvent::ApiServerStatus {
            running: false,
            message: String::new(),
            loaded_model: None,
        });
    }

    /// 對齊 unload-model：卸載目前模型（proxy 保持運行）
    pub async fn unload_model(&self) {
        self.backend.stop_current().await;
        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: "運行中 (未載入模型)".into(),
            loaded_model: None,
        });
    }

    /// proxy 是否運行中（存在未觸發的 shutdown sender 即視為運行中）
    pub async fn proxy_is_running(&self) -> bool {
        !self.shutdown_txs.lock().await.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_idle_duration_calc() {
        assert_eq!(idle_duration(0), None);
        assert_eq!(idle_duration(5), Some(Duration::from_secs(300)));
    }

    #[tokio::test]
    async fn test_start_rejected_without_binary() {
        let state = CoreState::new_for_test();
        let mgr = ApiManager::new_for_test(state.clone());
        // backend binary 不存在 → start 失敗（尚未安裝）
        // 注意：測試環境 bin/<platform>/llama-server(.exe) 可能不存在；若本機有安裝則此測試會失敗，
        // 因此改為驗證「未安裝時」的錯誤路徑 —— 以 paths::is_installed() 分支：
        if crate::paths::is_installed() {
            // 本機有安裝：跳過（CI 環境無 bin）
            return;
        }
        let r = mgr.start(ServerOptions::default()).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn test_stop_when_not_started_is_noop() {
        let state = CoreState::new_for_test();
        let mgr = ApiManager::new_for_test(state);
        mgr.stop().await; // 不應 panic
        assert!(!mgr.proxy_is_running().await);
    }
}
