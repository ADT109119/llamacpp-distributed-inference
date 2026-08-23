use crate::state::CoreState;
use crate::CoreEvent;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const RPC_PORT: u16 = 50052;

/// IPv4 格式驗證（對齊 index.js ipRegex；寬鬆語意：parse 成功即有效）
/// 注意：刻意不用嚴格正規表達式 —— Ipv4Addr::parse 拒絕前導零以外的所有無效格式，
/// 與 Electron 正規表達式行為等價（\d\d? 允許 "01" 這類前導零，parse 也接受）。
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let ev = rx.recv().await.unwrap();
        assert!(
            matches!(ev, CoreEvent::NodeUpdate(ref v) if v == &vec!["192.168.1.10".to_string()])
        );

        reg.add("10.0.0.1").await;
        let _ = rx.recv().await.unwrap();
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
            "192.168.1.7".into(),
        ])
        .await;
        let _ = rx.recv().await; // 至少一個 update
        let list = reg.list().await;
        assert!(
            list.contains(&"127.0.0.1".to_string()),
            "本機地址應映射: {list:?}"
        );
        assert!(list.contains(&"192.168.1.7".to_string()));
        assert_eq!(list.len(), 2);
    }
}
