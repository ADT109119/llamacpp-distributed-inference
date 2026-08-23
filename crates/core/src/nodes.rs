use crate::state::CoreState;
use crate::CoreEvent;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const RPC_PORT: u16 = 50052;

/// IPv4 格式驗證（對齊 index.js ipRegex 的意圖）。
/// 注意：Ipv4Addr::parse 拒絕前導零（如 "192.168.001.005"），比 Electron 正規表達式
/// （\d\d? 允許 "01"）更嚴格 —— 可接受，因為 mDNS 解析器只會輸出標準點分十進位。
pub fn is_valid_ipv4(s: &str) -> bool {
    s.parse::<std::net::Ipv4Addr>().is_ok()
}

/// 是否本機地址（127.0.0.1 / localhost / 本機網卡 IP）
pub fn is_local_address(addr: &str) -> bool {
    if addr == "127.0.0.1" || addr == "localhost" {
        return true;
    }
    local_ipv4_addrs().iter().any(|ip| ip.to_string() == addr)
}

/// 本機所有 IPv4 地址（不含 loopback）
pub fn local_ipv4_addrs() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|ifa| match ifa.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() => Some(IpAddr::V4(v4)),
            _ => None,
        })
        .collect()
}

/// mDNS 地址過濾決策（對齊 filterAndAddNode）：None = 跳過；Some(normalized) = 加入
pub fn filter_address(addr: &str) -> Option<String> {
    if addr.is_empty()
        || addr == "0.0.0.0"
        || addr.starts_with("169.254")
        || addr.contains(':')
        || !is_valid_ipv4(addr)
    {
        return None;
    }
    if is_local_address(addr) {
        Some("127.0.0.1".to_string())
    } else {
        Some(addr.to_string())
    }
}

/// 節點註冊表：去重集合（有序）+ node-update 事件發布
pub struct NodeRegistry {
    state: Arc<CoreState>,
    nodes: Mutex<BTreeSet<String>>,
}

impl NodeRegistry {
    pub fn new(state: Arc<CoreState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            nodes: Mutex::new(BTreeSet::new()),
        })
    }

    pub async fn list(&self) -> Vec<String> {
        self.nodes.lock().await.iter().cloned().collect()
    }

    pub async fn contains(&self, ip: &str) -> bool {
        self.nodes.lock().await.contains(ip)
    }

    /// 加入單一節點（已存在則無事發生）。回傳是否新加入。
    pub async fn add(&self, ip: &str) -> bool {
        let inserted = self.nodes.lock().await.insert(ip.to_string());
        if inserted {
            self.emit_update().await;
        }
        inserted
    }

    /// 批次套用過濾並加入（對齊 filterAndAddNode 整體行為）
    pub async fn add_filtered(&self, addresses: &[String]) {
        for addr in addresses {
            if let Some(normalized) = filter_address(addr) {
                self.add(&normalized).await;
            }
        }
    }

    pub async fn remove(&self, ip: &str) -> bool {
        let removed = self.nodes.lock().await.remove(ip);
        if removed {
            self.emit_update().await;
        }
        removed
    }

    async fn emit_update(&self) {
        let list = self.list().await;
        self.state.emit(CoreEvent::NodeUpdate(list));
    }
}

/// TCP 連接檢查（對齊 checkNodeConnection：port、5 秒逾時）
pub async fn check_node_connection(ip: &str, port: u16) -> bool {
    let addr = format!("{ip}:{port}");
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::TcpStream::connect(&addr),
        )
        .await,
        Ok(Ok(_))
    )
}

/// 本機介面列表（對齊 get-local-ips：所有 IPv4 {address, interface, internal}；
/// 失敗時 fallback [{address:"127.0.0.1",interface:"Loopback",internal:true}]）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInterface {
    pub address: String,
    pub interface: String,
    pub internal: bool,
}

pub fn get_local_ips() -> Vec<LocalInterface> {
    match if_addrs::get_if_addrs() {
        Ok(ifas) => {
            let mut out = Vec::new();
            for ifa in ifas {
                if let IpAddr::V4(v4) = ifa.ip() {
                    out.push(LocalInterface {
                        address: v4.to_string(),
                        interface: ifa.name.clone(),
                        internal: v4.is_loopback(),
                    });
                }
            }
            out
        }
        Err(_) => vec![LocalInterface {
            address: "127.0.0.1".into(),
            interface: "Loopback".into(),
            internal: true,
        }],
    }
}

/// 節點操作結果（對齊 add-manual-node / remove-node / check-node-connection 回傳形狀）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOpResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
    pub message: String,
}

impl NodeRegistry {
    /// 對齊 add-manual-node handler：
    /// IPv4 驗證 → 重複檢查 → 本機地址檢查 → TCP 檢查（無論可達與否都加入）
    pub async fn add_manual_node(self: &Arc<Self>, node_ip: &str) -> NodeOpResult {
        if !is_valid_ipv4(node_ip) {
            return NodeOpResult {
                success: false,
                reachable: None,
                message: "無效的IP 格式。".into(),
            };
        }
        if self.contains(node_ip).await {
            return NodeOpResult {
                success: false,
                reachable: None,
                message: "該節點已存在".into(),
            };
        }
        if is_local_address(node_ip) && node_ip != "127.0.0.1" {
            return NodeOpResult {
                success: false,
                reachable: None,
                message: "本機節點請使用 127.0.0.1".into(),
            };
        }
        let reachable = check_node_connection(node_ip, RPC_PORT).await;
        self.add(node_ip).await;
        NodeOpResult {
            success: true,
            reachable: Some(reachable),
            message: if reachable {
                format!("節點 {node_ip} 已添加並驗證連接正常。")
            } else {
                format!("節點 {node_ip} 已添加，但目前無法連接到RPC 伺服器 (端口 {RPC_PORT})")
            },
        }
    }

    /// 對齊 remove-node handler
    pub async fn remove_node(self: &Arc<Self>, node_ip: &str) -> NodeOpResult {
        if self.remove(node_ip).await {
            NodeOpResult {
                success: true,
                reachable: None,
                message: format!("節點 {node_ip} 已移除"),
            }
        } else {
            NodeOpResult {
                success: false,
                reachable: None,
                message: "節點不存在".into(),
            }
        }
    }

    /// 對齊 check-node-connection handler
    pub async fn check_node(self: &Arc<Self>, node_ip: &str) -> NodeOpResult {
        let reachable = check_node_connection(node_ip, RPC_PORT).await;
        NodeOpResult {
            success: true,
            reachable: Some(reachable),
            message: if reachable {
                format!("節點 {node_ip} 可以連線，RPC 伺服器運行正常。")
            } else {
                format!("無法連接到 {node_ip}:{RPC_PORT}，請確保目標設備已執行此程式")
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn recv_event(
        rx: &mut tokio::sync::broadcast::Receiver<crate::CoreEvent>,
    ) -> crate::CoreEvent {
        tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("event should arrive within 2s")
            .expect("channel open")
    }

    #[test]
    fn test_is_valid_ipv4() {
        assert!(is_valid_ipv4("192.168.1.10"));
        assert!(is_valid_ipv4("0.0.0.0")); // 格式有效；由 filter 排除
        assert!(!is_valid_ipv4("999.1.1.1"));
        assert!(!is_valid_ipv4("abc"));
        assert!(!is_valid_ipv4("192.168.1"));
        assert!(!is_valid_ipv4(""));
    }

    #[test]
    fn test_filter_address_rules() {
        assert_eq!(filter_address(""), None);
        assert_eq!(filter_address("0.0.0.0"), None);
        assert_eq!(filter_address("169.254.1.5"), None);
        assert_eq!(filter_address("fe80::1"), None); // 含 :
        assert_eq!(filter_address("not-an-ip"), None);
        // 本機映射
        assert_eq!(filter_address("127.0.0.1"), Some("127.0.0.1".into()));
        // 一般遠端
        assert_eq!(filter_address("192.168.1.10"), Some("192.168.1.10".into()));
    }

    #[tokio::test]
    async fn test_registry_add_remove_emit() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        let mut rx = state.subscribe();

        assert!(reg.add("192.168.1.10").await);
        assert!(!reg.add("192.168.1.10").await); // 重複不加
        let ev = recv_event(&mut rx).await;
        assert!(
            matches!(ev, CoreEvent::NodeUpdate(ref v) if v == &vec!["192.168.1.10".to_string()])
        );

        reg.add("10.0.0.1").await;
        let _ = recv_event(&mut rx).await;
        assert_eq!(
            reg.list().await,
            vec!["10.0.0.1".to_string(), "192.168.1.10".to_string()]
        );

        assert!(reg.remove("192.168.1.10").await);
        assert!(!reg.remove("192.168.1.10").await);
        assert_eq!(reg.list().await, vec!["10.0.0.1".to_string()]);
    }

    #[tokio::test]
    async fn test_add_filtered_maps_localhost() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        let mut rx = state.subscribe();
        reg.add_filtered(&[
            "169.254.9.9".into(),
            "fe80::x".into(),
            "127.0.0.1".into(),
            "192.0.2.7".into(),
        ])
        .await;
        let _ = recv_event(&mut rx).await; // 至少一個 update
        let list = reg.list().await;
        assert!(
            list.contains(&"127.0.0.1".to_string()),
            "本機地址應映射: {list:?}"
        );
        assert!(list.contains(&"192.0.2.7".to_string()));
        assert_eq!(list.len(), 2);
    }

    #[tokio::test]
    async fn test_manual_add_validation_errors() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let r = reg.add_manual_node("not-an-ip").await;
        assert!(!r.success);
        assert!(r.message.contains("無效"));

        let r = reg.add_manual_node("300.1.1.1").await;
        assert!(!r.success);

        let r1 = reg.add_manual_node("192.168.99.99").await;
        assert!(r1.success);
        let r2 = reg.add_manual_node("192.168.99.99").await;
        assert!(!r2.success && r2.message == "該節點已存在");
    }

    #[tokio::test]
    async fn test_manual_add_unreachable_still_added() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        // TEST-NET-3 位址，保證不可達且不會誤連外網（TCP 檢查將等待完整 5 秒逾時）
        let r = reg.add_manual_node("203.0.113.1").await;
        assert!(r.success);
        assert_eq!(r.reachable, Some(false));
        assert!(reg.contains("203.0.113.1").await);
    }

    #[tokio::test]
    async fn test_remove_node_semantics() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let r = reg.remove_node("10.1.1.1").await;
        assert!(!r.success && r.message == "節點不存在");
        reg.add_manual_node("10.1.1.1").await;
        let r = reg.remove_node("10.1.1.1").await;
        assert!(r.success);
    }

    #[test]
    fn test_get_local_ips_shape() {
        let ips = get_local_ips();
        assert!(!ips.is_empty());
        assert!(ips
            .iter()
            .all(|i| i.address.parse::<std::net::Ipv4Addr>().is_ok()));
    }
}
