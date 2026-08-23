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
    /// （Arc 包裝讓啟動失敗的背景任務能以 same_channel 精確識別並移除自己）
    shutdown_txs: Mutex<Vec<Arc<watch::Sender<bool>>>>,
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
        let mgr = Arc::new(Self {
            state,
            backend,
            proxy,
            shutdown_txs: Mutex::new(Vec::new()),
            idle_notify,
            last_options: Arc::new(tokio::sync::RwLock::new(None)),
        });
        // 單一長壽閒置監看：隨管理器建立一次，不再每次 start 重複 spawn
        // （舊做法會殘留監看任務，逾時可能在下個 session 誤卸載新模型）
        Self::spawn_idle_watcher(Arc::clone(&mgr));
        mgr
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

    /// 對齊 start-api-server handler：啟 proxy（背景）、記住 options
    /// （閒置監看已改為 new() 建立的單一長壽任務，此處不再重複 spawn）
    pub async fn start(self: &Arc<Self>, options: ServerOptions) -> Result<(), String> {
        if !crate::paths::is_installed() {
            return Err("尚未安裝 llama.cpp 核心檔案，請先更新安裝。".into());
        }
        // TOCTOU 防護：「已在運行」檢查與註冊 shutdown handle 必須在同一鎖區間內，
        // 避免兩個並發 start 同時通過檢查
        let (rx, tx_handle) = {
            let mut txs = self.shutdown_txs.lock().await;
            if !txs.is_empty() {
                return Err("API 主伺服器已在運行中".into());
            }
            let (tx, rx) = watch::channel(false);
            let tx = Arc::new(tx);
            txs.push(Arc::clone(&tx));
            (rx, tx)
        };
        *self.last_options.write().await = Some(options.clone());

        // proxy 生命周期（獨立 shutdown channel；啟動失敗時自我清理）
        let proxy = self.proxy.clone();
        let opts = options;
        let mgr_for_cleanup = Arc::clone(self);
        let state_for_err = self.state.clone();
        tokio::spawn(async move {
            if let Err(e) = proxy.run(rx, opts).await {
                // 啟動失敗：移除對應的 shutdown handle 並回報錯誤
                mgr_for_cleanup.remove_shutdown_tx(&tx_handle).await;
                state_for_err.emit(CoreEvent::ApiServerError(format!(
                    "API 代理伺服器啟動失敗: {e}"
                )));
                state_for_err.emit(CoreEvent::ApiServerStatus {
                    running: false,
                    message: format!("API 代理伺服器啟動失敗: {e}"),
                    loaded_model: None,
                });
            }
        });

        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: "待機中 (未載入模型)".into(),
            loaded_model: None,
        });
        Ok(())
    }

    /// 單一長壽閒置監看：等待 idle_notify 觸碰，逾時且 proxy 仍運行時卸載模型
    fn spawn_idle_watcher(mgr: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                let dur = {
                    let lo = mgr.last_options.read().await;
                    lo.as_ref().and_then(|o| idle_duration(o.idle_timeout))
                };
                match dur {
                    None => mgr.idle_notify.notified().await, // 停用：只等 touch 重置
                    Some(d) => {
                        if tokio::time::timeout(d, mgr.idle_notify.notified())
                            .await
                            .is_err()
                        {
                            // 閒置逾時 → 僅在 proxy 仍運行時才卸載，
                            // 防止 stop 後殘留的逾時誤砍新 session 的模型
                            if !mgr.proxy_is_running().await {
                                continue;
                            }
                            if mgr.backend.is_loaded().await {
                                if let Some(m) = mgr.backend.active_model().await {
                                    mgr.state.emit(CoreEvent::ApiServerLog(format!(
                                        "[閒置管理] 偵測到已閒置 {} 分鐘，自動卸載模型 \"{m}\" 以釋放系統資源...\n",
                                        mgr.last_options.read().await.as_ref().map(|o| o.idle_timeout).unwrap_or(0)
                                    )));
                                    mgr.backend.stop_current().await;
                                    mgr.state.emit(CoreEvent::ApiServerStatus {
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
    }

    /// 移除指定的 shutdown sender（以 channel 身分精確比對），
    /// 並順手掃掉其他已關閉（receiver 皆丟棄）的殘留條目
    async fn remove_shutdown_tx(&self, tx: &watch::Sender<bool>) {
        self.shutdown_txs
            .lock()
            .await
            .retain(|s| !s.is_closed() && !s.same_channel(tx));
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

    /// 啟動失敗清理語意：receiver 已丟棄（is_closed）的條目應被清掉，存活條目保留
    #[tokio::test]
    async fn test_remove_shutdown_tx_sweeps_dead_entries_only() {
        let state = CoreState::new_for_test();
        let mgr = ApiManager::new_for_test(state);
        // 模擬「啟動失敗」：run() 結束後 receiver 掉了 → sender 關閉
        let (dead_tx, dead_rx) = watch::channel(false);
        drop(dead_rx);
        assert!(dead_tx.is_closed());
        let (_live_tx, _live_rx) = watch::channel(false);
        {
            let mut v = mgr.shutdown_txs.lock().await;
            v.push(Arc::new(dead_tx));
            v.push(Arc::new(_live_tx));
        }
        assert!(mgr.proxy_is_running().await);

        // 傳入任一未註冊的 sender：僅掃掉已關閉條目，不影響存活者
        let (probe, _probe_rx) = watch::channel(false);
        mgr.remove_shutdown_tx(&probe).await;

        assert!(mgr.proxy_is_running().await, "存活條目不應被移除");
        let v = mgr.shutdown_txs.lock().await;
        assert_eq!(v.len(), 1, "應只移除已關閉（失敗）的條目");
        assert!(!v[0].is_closed());
    }

    /// remove_shutdown_tx 應以 channel 身分比對，只移除完全相符的那一筆
    #[tokio::test]
    async fn test_remove_shutdown_tx_exact_match() {
        let state = CoreState::new_for_test();
        let mgr = ApiManager::new_for_test(state);
        let (tx1, _rx1) = watch::channel(false);
        let (tx2, _rx2) = watch::channel(false);
        {
            let mut v = mgr.shutdown_txs.lock().await;
            v.push(Arc::new(tx1));
            v.push(Arc::new(tx2));
        }
        // 取得第二筆的識別 handle（Arc 複製指向同一 channel，向量內容不變）
        let target: Arc<watch::Sender<bool>> = {
            let v = mgr.shutdown_txs.lock().await;
            Arc::clone(&v[1])
        };
        mgr.remove_shutdown_tx(&target).await;

        {
            let v = mgr.shutdown_txs.lock().await;
            assert_eq!(v.len(), 1, "僅移除完全相符的 channel");
            assert!(!v[0].is_closed());
        }
    }
}
