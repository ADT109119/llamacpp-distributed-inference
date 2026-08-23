use crate::config::Config;
use crate::CoreEvent;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

/// 核心共享狀態：事件匯流排 + 設定。
pub struct CoreState {
    config: Mutex<Config>,
    events: broadcast::Sender<CoreEvent>,
}

impl CoreState {
    pub fn new(config: Config) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            config: Mutex::new(config),
            events,
        })
    }

    /// 測試用：預設設定
    pub fn new_for_test() -> Arc<Self> {
        Self::new(Config::default())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    /// 發布事件（無訂閱者時靜默忽略）
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    pub async fn config(&self) -> Config {
        self.config.lock().await.clone()
    }

    pub async fn update_config(&self, config: Config) {
        *self.config.lock().await = config;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_event_bus_publish_subscribe() {
        let state = CoreState::new_for_test();
        let mut rx = state.subscribe();
        state.emit(CoreEvent::RpcServerStatus(true));
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev, CoreEvent::RpcServerStatus(true)));
    }
}
