use crate::nodes::{filter_address, NodeRegistry, RPC_PORT};
use crate::state::CoreState;
use crate::{CoreEvent, Subsystem};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::runtime::Handle;

/// mDNS 服務類型（對齊 Electron serviceType 'llm-cluster'）
pub const SERVICE_TYPE: &str = "_llm-cluster._tcp.local.";

/// stop 時釋放的資源：daemon（shutdown 以關閉常駐瀏覽事件流與發布服務）。
/// mdns-sd 的 daemon thread 沒有 Drop 實作，handle drop 不會停止它，
/// 必須明確呼叫 shutdown() 送出 Command::Exit，事件流才會關閉、瀏覽任務才能結束。
struct MdnsHandle {
    daemon: ServiceDaemon,
}

/// mDNS 節點發現服務（對齊 index.js startMdnsDiscovery）：
/// 發布本機 `_llm-cluster._tcp.local.` 服務、常駐瀏覽網路節點。
///
/// 補掃策略差異：Electron 版使用 bonjour-service，其瀏覽不會自動重查，
/// 需每 30 秒手動開窗補掃以捕捉遺漏的節點上下線。mdns-sd 的常駐瀏覽
/// 內建持續重查機制（查詢重傳退避 + 記錄 TTL 到期前的快取刷新查詢），
/// 單一常駐瀏覽即涵蓋手動補掃的意圖，故此處不再實作週期補掃。
/// 此外 mdns-sd 對同一服務類型僅維護一個 querier（後註冊者直接覆蓋前者的
/// 事件通道），常駐瀏覽與週期補掃無法並存——若併行 browse 會使常駐瀏覽
/// 的事件流失效、再經 stop_browse 整組移除，導致探索靜默失效。
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

        // 常駐瀏覽：mdns-sd 內建持續重查（取代 Electron 版的 30 秒手動補掃），
        // 事件處理由此任務統一承擔
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

        *guard = Some(MdnsHandle { daemon });

        self.state.emit(CoreEvent::Log(
            Subsystem::Sys,
            "Starting mDNS discovery...".to_string(),
        ));
    }

    /// 停止：關閉 daemon（同時終止其唯一 querier 的常駐瀏覽）。
    /// mdns-sd 的 daemon thread 不會因 handle drop 而停止（無 Drop impl），
    /// 必須明確 shutdown() 送出 Command::Exit，事件流才會關閉、常駐瀏覽任務才能結束。
    pub async fn stop(&self) {
        if let Some(handle) = self.lock_handle().take() {
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
/// 逐事件交給 [`handle_mdns_event`]，收到 SearchStopped 或事件流關閉時結束。
fn run_persistent_browse(
    runtime: Handle,
    registry: Arc<NodeRegistry>,
    receiver: mdns_sd::Receiver<ServiceEvent>,
) {
    let mut addr_map: HashMap<String, Vec<String>> = HashMap::new();
    while let Ok(event) = receiver.recv() {
        if !runtime.block_on(handle_mdns_event(&registry, &mut addr_map, event)) {
            break;
        }
    }
}

/// 處理單一 mDNS 事件（回傳是否應繼續瀏覽）。
/// - ServiceResolved：記錄 fullname → 地址對照表並批次過濾加入註冊表；
///   地址為空時忽略（尚未取得 A 記錄）。
/// - ServiceRemoved：只帶 fullname，從對照表還原地址，逐一過濾後移除，
///   並移除對照表條目。
/// - SearchStopped：回傳 false 結束迴圈。
/// - 其餘事件（SearchStarted / ServiceFound）：忽略並繼續。
async fn handle_mdns_event(
    registry: &Arc<NodeRegistry>,
    addr_map: &mut HashMap<String, Vec<String>>,
    event: ServiceEvent,
) -> bool {
    match event {
        ServiceEvent::ServiceResolved(info) => {
            let addrs: Vec<String> = info
                .get_addresses()
                .iter()
                .map(std::string::ToString::to_string)
                .collect();
            if !addrs.is_empty() {
                addr_map.insert(info.get_fullname().to_string(), addrs.clone());
                registry.add_filtered(&addrs).await;
            }
            true
        }
        ServiceEvent::ServiceRemoved(_, fullname) => {
            if let Some(addrs) = addr_map.remove(&fullname) {
                for addr in addrs {
                    if let Some(normalized) = filter_address(&addr) {
                        registry.remove(&normalized).await;
                    }
                }
            }
            true
        }
        ServiceEvent::SearchStopped(_) => false,
        _ => true,
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

    /// 建立已帶地址的 ServiceInfo（模擬 ServiceResolved 事件內容）。
    /// mdns-sd 0.11 的 ServiceInfo::new 直接由 ip 參數填入 get_addresses()，
    /// 無需 resolve 步驟。地址使用 TEST-NET-1（192.0.2.0/24）避免觸及本機網卡判斷。
    fn resolved_info(instance: &str, ip: &str) -> ServiceInfo {
        ServiceInfo::new(
            SERVICE_TYPE,
            instance,
            &format!("{instance}.local."),
            ip,
            RPC_PORT,
            None,
        )
        .expect("test ServiceInfo should be valid")
    }

    #[tokio::test]
    async fn test_handle_event_resolve_adds_node() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let mut map = HashMap::new();

        let info = resolved_info("LLMNode-X", "192.0.2.50");
        let fullname = info.get_fullname().to_string();
        let cont = handle_mdns_event(&reg, &mut map, ServiceEvent::ServiceResolved(info)).await;

        assert!(cont);
        assert!(
            reg.list().await.contains(&"192.0.2.50".to_string()),
            "resolved 節點應加入註冊表"
        );
        assert_eq!(
            map.get(&fullname),
            Some(&vec!["192.0.2.50".to_string()]),
            "fullname → 地址對照表應記錄"
        );
    }

    #[tokio::test]
    async fn test_handle_event_resolve_empty_addrs_ignored() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let mut map = HashMap::new();

        // 空 ip 字串 → 空地址集（未取得 A 記錄），應忽略但繼續瀏覽
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            "LLMNode-E",
            "LLMNode-E.local.",
            "",
            RPC_PORT,
            None,
        )
        .expect("test ServiceInfo should be valid");
        let cont = handle_mdns_event(&reg, &mut map, ServiceEvent::ServiceResolved(info)).await;

        assert!(cont);
        assert!(reg.list().await.is_empty());
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn test_handle_event_removed_removes_node() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let mut map = HashMap::new();

        let info = resolved_info("LLMNode-Y", "192.0.2.51");
        let fullname = info.get_fullname().to_string();
        handle_mdns_event(&reg, &mut map, ServiceEvent::ServiceResolved(info)).await;
        assert!(reg.contains("192.0.2.51").await);

        let cont = handle_mdns_event(
            &reg,
            &mut map,
            ServiceEvent::ServiceRemoved(SERVICE_TYPE.to_string(), fullname.clone()),
        )
        .await;

        assert!(cont);
        assert!(!reg.contains("192.0.2.51").await, "removed 後節點應消失");
        assert!(!map.contains_key(&fullname), "對照表條目應移除");
    }

    #[tokio::test]
    async fn test_handle_event_removed_unknown_fullname_is_noop() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let mut map = HashMap::new();

        // 未曾 resolve 的 fullname：不 panic、不影響既有節點、繼續瀏覽
        reg.add("127.0.0.1").await;
        let cont = handle_mdns_event(
            &reg,
            &mut map,
            ServiceEvent::ServiceRemoved(
                SERVICE_TYPE.to_string(),
                "LLMNode-Zzz._llm-cluster._tcp.local.".to_string(),
            ),
        )
        .await;

        assert!(cont);
        assert!(reg.contains("127.0.0.1").await);
    }

    #[tokio::test]
    async fn test_handle_event_search_stopped_returns_false() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let mut map = HashMap::new();

        let cont = handle_mdns_event(
            &reg,
            &mut map,
            ServiceEvent::SearchStopped(SERVICE_TYPE.to_string()),
        )
        .await;

        assert!(!cont);
        assert!(map.is_empty());
    }
}
