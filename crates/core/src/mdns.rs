use crate::nodes::{filter_address, NodeRegistry, RPC_PORT};
use crate::state::CoreState;
use crate::{CoreEvent, Subsystem};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::runtime::Handle;

/// mDNS 服務類型（對齊 Electron serviceType 'llm-cluster'）
pub const SERVICE_TYPE: &str = "_llm-cluster._tcp.local.";

const PERIODIC_SCAN_INTERVAL: Duration = Duration::from_secs(30);
const PERIODIC_SCAN_WINDOW: Duration = Duration::from_secs(5);

/// stop 時釋放的資源：daemon（shutdown 以關閉常駐瀏覽事件流）+ 週期補掃開關
struct MdnsHandle {
    daemon: ServiceDaemon,
    periodic_running: Arc<AtomicBool>,
}

/// mDNS 節點發現服務（對齊 index.js startMdnsDiscovery）：
/// 發布本機 `_llm-cluster._tcp.local.` 服務、常駐瀏覽網路節點、週期補掃。
pub struct MdnsService {
    state: Arc<CoreState>,
    registry: Arc<NodeRegistry>,
    handle: Mutex<Option<MdnsHandle>>,
    service_name: String,
}

impl MdnsService {
    pub fn new(state: Arc<CoreState>, registry: Arc<NodeRegistry>) -> Arc<Self> {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown".to_string());
        Arc::new(Self {
            state,
            registry,
            handle: Mutex::new(None),
            service_name: format!("LLMNode-{hostname}"),
        })
    }

    /// 啟動發布與瀏覽（已啟動則冪等返回；任何失敗只記 Log，不 panic）
    pub async fn start(&self) {
        let mut guard = self.lock_handle();
        if guard.is_some() {
            return;
        }

        let daemon = match ServiceDaemon::new() {
            Ok(daemon) => daemon,
            Err(e) => {
                self.state.emit(CoreEvent::Log(
                    Subsystem::Sys,
                    format!("Failed to start mDNS discovery: {e}"),
                ));
                return;
            }
        };

        // 發布本機服務；addr_auto 讓 daemon 填入本機網卡地址（對齊 bonjour.publish 行為）
        let publish_result = ServiceInfo::new(
            SERVICE_TYPE,
            &self.service_name,
            &format!("{}.local.", self.service_name),
            "",
            RPC_PORT,
            &[
                ("version", "1.0.0"),
                ("platform", crate::paths::platform_id()),
            ][..],
        )
        .map(ServiceInfo::enable_addr_auto)
        .and_then(|info| daemon.register(info));
        if let Err(e) = publish_result {
            self.state.emit(CoreEvent::Log(
                Subsystem::Sys,
                format!("mDNS service publish error: {e}"),
            ));
        }

        // 常駐瀏覽：mdns-sd 多 browse 共享同一事件流，事件處理由此任務統一承擔
        match daemon.browse(SERVICE_TYPE) {
            Ok(receiver) => {
                let runtime = Handle::current();
                let registry = self.registry.clone();
                tokio::task::spawn_blocking(move || {
                    run_persistent_browse(runtime, registry, receiver);
                });
            }
            Err(e) => {
                self.state.emit(CoreEvent::Log(
                    Subsystem::Sys,
                    format!("mDNS browse failed to start: {e}"),
                ));
            }
        }

        // 週期補掃（對齊 discoveryInterval 每 30 秒開窗 5 秒）
        let periodic_running = Arc::new(AtomicBool::new(true));
        tokio::spawn(run_periodic_scan(daemon.clone(), periodic_running.clone()));

        *guard = Some(MdnsHandle {
            daemon,
            periodic_running,
        });

        self.state.emit(CoreEvent::Log(
            Subsystem::Sys,
            "Starting mDNS discovery...".to_string(),
        ));
    }

    /// 停止：關閉週期補掃、關閉 daemon。
    /// mdns-sd 的 daemon thread 不會因 handle drop 而停止（無 Drop impl），
    /// 必須明確 shutdown() 送出 Command::Exit，事件流才會關閉、常駐瀏覽任務才能結束。
    pub async fn stop(&self) {
        if let Some(handle) = self.lock_handle().take() {
            handle.periodic_running.store(false, Ordering::Relaxed);
            let _ = handle.daemon.shutdown();
        }
    }

    fn lock_handle(&self) -> MutexGuard<'_, Option<MdnsHandle>> {
        self.handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 常駐瀏覽事件迴圈（同步，跑在 blocking thread）：
/// ServiceFound 只帶 fullname，地址在 ServiceResolved 抵達；
/// ServiceRemoved 也只帶 fullname，故以 fullname → 地址 對照表還原待移除節點。
fn run_persistent_browse(
    runtime: Handle,
    registry: Arc<NodeRegistry>,
    receiver: mdns_sd::Receiver<ServiceEvent>,
) {
    let mut resolved_addrs: HashMap<String, Vec<String>> = HashMap::new();
    while let Ok(event) = receiver.recv() {
        match event {
            ServiceEvent::ServiceFound(_, _) | ServiceEvent::SearchStarted(_) => {}
            ServiceEvent::ServiceResolved(info) => {
                let addrs: Vec<String> =
                    info.get_addresses().iter().map(|a| a.to_string()).collect();
                if addrs.is_empty() {
                    continue;
                }
                resolved_addrs.insert(info.get_fullname().to_string(), addrs.clone());
                runtime.block_on(registry.add_filtered(&addrs));
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                if let Some(addrs) = resolved_addrs.remove(&fullname) {
                    for addr in addrs {
                        if let Some(normalized) = filter_address(&addr) {
                            runtime.block_on(registry.remove(&normalized));
                        }
                    }
                }
            }
            ServiceEvent::SearchStopped(_) => break,
        }
    }
}

async fn run_periodic_scan(daemon: ServiceDaemon, running: Arc<AtomicBool>) {
    loop {
        if !running.load(Ordering::Relaxed) {
            break;
        }
        if daemon.browse(SERVICE_TYPE).is_ok() {
            tokio::time::sleep(PERIODIC_SCAN_WINDOW).await;
            let _ = daemon.stop_browse(SERVICE_TYPE);
            tokio::time::sleep(PERIODIC_SCAN_INTERVAL - PERIODIC_SCAN_WINDOW).await;
        } else {
            // daemon 異常：等下一輪再試
            tokio::time::sleep(PERIODIC_SCAN_INTERVAL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::NodeRegistry;

    #[test]
    fn test_service_type_constant() {
        assert_eq!(SERVICE_TYPE, "_llm-cluster._tcp.local.");
    }

    #[tokio::test]
    async fn test_start_stop_idempotent() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        reg.add("127.0.0.1").await; // 對齊啟動時加入 localhost
        let svc = MdnsService::new(state, reg);
        svc.start().await; // 不應 panic；即使 mDNS 初始化失敗也要優雅
        svc.start().await; // 冪等
        svc.stop().await;
        svc.stop().await; // 冪等
    }

    #[tokio::test]
    async fn test_service_name_format() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        let svc = MdnsService::new(state, reg);
        assert!(svc.service_name.starts_with("LLMNode-"));
        assert!(svc.service_name.len() > "LLMNode-".len());
    }
}
