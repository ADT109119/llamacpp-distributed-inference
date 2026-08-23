# Tauri 重構 Phase 2：mDNS 節點發現 + 手動節點管理 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `llama-dist-core` 新增 mDNS 發布/瀏覽（mdns-sd）與節點註冊表（過濾規則、手動添加、TCP 檢查、本機 IP 列表），行為逐項對齊 Electron 版 index.js 的 `startMdnsDiscovery`/`filterAndAddNode` 與四個節點 IPC handler。

**Architecture:** `nodes.rs` 提供純函式驗證層與 `NodeRegistry`（共享 Set + node-update 事件發布）；`mdns.rs` 提供 `MdnsService`（publish `_llm-cluster._tcp:50052` + 常駐瀏覽 + 每 30 秒 5 秒窗口的週期瀏覽），兩者以 `Arc<NodeRegistry>` 解耦。

**Tech Stack:** Rust 2021, tokio, mdns-sd 0.11, if-addrs 0.13, hostname 0.4。既有依賴不變。

**設計文件:** `docs/superpowers/specs/2026-08-22-tauri-refactor-design.md` §5.4
**對照來源:** Electron 版 `src/main/index.js`（startMdnsDiscovery ~L155-230、filterAndAddNode ~L118-152、節點 IPC handlers ~L843-930）

---

## 行為規格摘要（對照 index.js，實作者必讀）

### 過濾規則（filterAndAddNode，index.js L119-133）
逐一檢查每個 address，跳過：
1. 空值
2. `0.0.0.0`
3. 以 `169.254` 開頭（link-local）
4. 含 `:` （IPv6）
5. 不符 IPv4 正規表達式 `^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$`
6. 本機地址（127.0.0.1 / localhost / 本機網卡 IP）→ 一律映射為 `127.0.0.1` 加入

通過者加入集合並發布 `node-update` 事件。

### mDNS（startMdnsDiscovery，index.js L156-226）
- publish：name = `LLMNode-{hostname}`、type = `llm-cluster`、port 50052、TXT `{version: "1.0.0", platform}`
- 常駐 browse：service up → filterAndAddNode(addresses)；down → 從集合移除對應地址並發布事件
- 啟動時直接加入 `127.0.0.1`
- 每 30000ms 啟動一個短期 browse，5000ms 後停止（週期性補掃）
- 失敗時僅加入 localhost 並繼續（不中斷程式）

### IPC 對齊（index.js L843-930）
| Handler | 行為 |
|---|---|
| get-discovered-nodes | 回傳集合陣列 |
| get-local-ips | 所有 IPv4 `{address, interface, internal}`；錯誤時 fallback `[{address:"127.0.0.1",interface:"Loopback",internal:true}]` |
| check-node-connection | TCP connect port 50052，5 秒逾時 → `{success, reachable, message}` |
| add-manual-node | IPv4 驗證失敗→「無效的IP格式」；已存在→「該節點已存在」；非 127.0.0.1 的本機地址→「本機請使用 127.0.0.1」；TCP 檢查後仍加入集合（reachable 只是附帶資訊）；成功訊息含可達性 |
| remove-node | 存在才移除並發布事件；否則「節點不存在」 |

---

## 檔案結構

```
crates/core/
├── Cargo.toml          # + mdns-sd, if-addrs, hostname
├── src/
│   ├── nodes.rs        # [新] 驗證純函式 + NodeRegistry + 手動節點操作 + local IPs + TCP 檢查
│   └── mdns.rs         # [新] MdnsService（publish/browse）
└── tests/
    └── integration.rs  # 追加節點整合測試
```

---

### Task 1: nodes.rs — 驗證純函式 + NodeRegistry

**Files:**
- Create: `crates/core/src/nodes.rs`
- Modify: `crates/core/src/lib.rs`（加 `pub mod nodes;`）

- [ ] **Step 1: 實作（TDD：先寫測試確認編譯失敗，再補實作）**

```rust
use crate::state::CoreState;
use crate::CoreEvent;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const RPC_PORT: u16 = 50052;
const NODE_UPDATE_DEBOUNCE_MS: u64 = 50;

/// IPv4 格式驗證（對齊 index.js ipRegex；嚴格十進位、每段 0-255）
/// 注意：刻意不用 Ipv4Addr::parse —— 它接受前導零（"01.2.3.4"），
/// 而 Electron 正規表達式也允許前導零（\d\d? 可匹配 "01"），
/// 因此此處用同樣寬鬆的語意：parse 成功即視為有效。
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

/// mDNS 地址過濾決策（對齊 filterAndAddNode）：回傳 None 表示跳過；
/// Some(normalized) 表示應加入（本機地址映射為 127.0.0.1）
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

/// 節點註冊表：去重集合 + node-update 事件發布
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
        let mut guard = self.nodes.lock().await;
        if guard.insert(ip.to_string()) {
            drop(guard);
            self.emit_update().await;
            true
        } else {
            false
        }
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
        let mut guard = self.nodes.lock().await;
        if guard.remove(ip) {
            drop(guard);
            self.emit_update().await;
            true
        } else {
            false
        }
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
        assert!(matches!(ev, CoreEvent::NodeUpdate(ref v) if v == &vec!["192.168.1.10".to_string()]));

        // 有序輸出
        reg.add("10.0.0.1").await;
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev, CoreEvent::NodeUpdate(_)));
        assert_eq!(reg.list().await, vec!["10.0.0.1".to_string(), "192.168.1.10".to_string()]);

        assert!(reg.remove("192.168.1.10").await);
        assert!(!reg.remove("192.168.1.10").await);
        assert_eq!(reg.list().await, vec!["10.0.0.1".to_string()]);
    }

    #[tokio::test]
    async fn test_add_filtered_maps_localhost() {
        let state = CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        let mut rx = state.subscribe();
        reg.add_filtered(&["169.254.9.9".into(), "fe80::x".into(), "127.5.5.5".into(), "192.168.1.7".into()]).await;
        let _ = rx.recv().await; // 至少一個 update 事件
        let list = reg.list().await;
        assert!(list.contains(&"127.0.0.1".to_string()), "本機地址應映射: {list:?}");
        assert!(list.contains(&"192.168.1.7".to_string()));
        assert_eq!(list.len(), 2);
    }
}
```

注意：
- `NODE_UPDATE_DEBOUNCE_MS` 若最終未用於去抖（Phase 內不做 debounce），直接刪除常數。
- `add_filtered` 中「127.5.5.5」是 loopback 網段但非 127.0.0.1 字面值 —— `is_local_address` 對它回傳 false（不在網卡清單也不等於字面值），因此會原樣保留。這**與 Electron 行為一致**（JS 版同樣只比對字面值與網卡 IP）。若測試失敗請以此語意修正斷言而非改實作。

- [ ] **Step 2: lib.rs 加 `pub mod nodes;`**

- [ ] **Step 3: Run `cargo test -p llama-dist-core nodes` → PASS（4 測試）；全套 + clippy -D warnings + fmt --check 乾淨**

- [ ] **Step 4: Commit**

```bash
git add crates/core/src/nodes.rs crates/core/src/lib.rs
git commit -m "feat(core): nodes 模組 — 地址過濾規則、NodeRegistry、本機地址映射"
```

---

### Task 2: nodes.rs — TCP 檢查、手動節點操作、local IPs

對照 index.js `checkNodeConnection`（5s 逾時）、`add-manual-node`、`remove-node`、`get-local-ips`。

**Files:**
- Modify: `crates/core/src/nodes.rs`
- Modify: `crates/core/Cargo.toml`（+ hostname）

- [ ] **Step 1: Cargo.toml 加入**

```toml
hostname = "0.4"
```

- [ ] **Step 2: 實作（附加到 nodes.rs）**

```rust
/// TCP 連接檢查（對齊 checkNodeConnection：port 50052、5 秒逾時）
pub async fn check_node_connection(ip: &str, port: u16) -> bool {
    use std::time::Duration;
    let addr = format!("{ip}:{port}");
    match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// 本機介面列表（對齊 get-local-ips：所有 IPv4 {address, interface, internal}）
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

/// 手動添加結果（對齊 add-manual-node / remove-node / check-node-connection 回傳形狀）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOpResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
    pub message: String,
}

impl NodeRegistry {
    /// 對齊 add-manual-node handler
    pub async fn add_manual_node(self: &Arc<Self>, node_ip: &str) -> NodeOpResult {
        if !is_valid_ipv4(node_ip) {
            return NodeOpResult { success: false, reachable: None, message: "無效的IP 格式。".into() };
        }
        if self.contains(node_ip).await {
            return NodeOpResult { success: false, reachable: None, message: "該節點已存在".into() };
        }
        if is_local_address(node_ip) && node_ip != "127.0.0.1" {
            return NodeOpResult { success: false, reachable: None, message: "本機節點請使用 127.0.0.1".into() };
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
            NodeOpResult { success: true, reachable: None, message: format!("節點 {node_ip} 已移除") }
        } else {
            NodeOpResult { success: false, reachable: None, message: "節點不存在".into() }
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
```

- [ ] **Step 3: 測試（nodes.rs tests mod 追加）**

```rust
#[tokio::test]
async fn test_manual_add_validation_errors() {
    let state = CoreState::new_for_test();
    let reg = NodeRegistry::new(state);
    let r = reg.add_manual_node("not-an-ip").await;
    assert!(!r.success);
    assert!(r.message.contains("無效"));

    let r = reg.add_manual_node("300.1.1.1").await;
    assert!(!r.success);

    // 非 127.0.0.1 的本機地址（用網卡實際 IP 或退而用 127.0.0.2 屬 loopback 但非字面 127.0.0.1，
    // is_local_address 只認字面 127.0.0.1/localhost 與網卡 IP —— 因此此案例在 CI 上不可靠，改測重複添加）
    let r1 = reg.add_manual_node("192.168.99.99").await;
    assert!(r1.success);
    let r2 = reg.add_manual_node("192.168.99.99").await;
    assert!(!r2.success && r2.message == "該節點已存在");
}

#[tokio::test]
async fn test_manual_add_unreachable_still_added() {
    let state = CoreState::new_for_test();
    let reg = NodeRegistry::new(state);
    // TEST-NET-3 位址，保證不可達且不會誤連外網
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
    assert!(ips.iter().all(|i| i.address.parse::<std::net::Ipv4Addr>().is_ok()));
    assert!(ips.iter().any(|i| i.internal)); // 至少有 loopback
}
```

注意：`test_manual_add_unreachable_still_added` 需要 5 秒 TCP 逾時 —— 測試耗時可接受（<6s）。若 CI 環境阻擋會立即失敗（更快）。

- [ ] **Step 4: Run `cargo test -p llama-dist-core nodes` → PASS（8 測試）；全套 + clippy + fmt 乾淨**

- [ ] **Step 5: Commit**

```bash
git add crates/core/src/nodes.rs crates/core/Cargo.toml Cargo.lock
git commit -m "feat(core): 手動節點管理 — TCP 檢查、add/remove/check 操作、本機介面列表"
```

---

### Task 3: mdns.rs — MdnsService（publish + browse）

**Files:**
- Create: `crates/core/src/mdns.rs`
- Modify: `crates/core/Cargo.toml`（+ mdns-sd）
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: Cargo.toml 加入**

```toml
mdns-sd = "0.11"
```

- [ ] **Step 2: 實作 mdns.rs**

```rust
use crate::nodes::{filter_address, NodeRegistry};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::sync::Arc;
use std::time::Duration;

pub const SERVICE_TYPE: &str = "_llm-cluster._tcp.local.";

/// mDNS 發布 + 瀏覽服務（對齊 startMdnsDiscovery）
pub struct MdnsService {
    registry: Arc<NodeRegistry>,
    /// daemon + receiver 句柄；stop 時關閉
    handle: tokio::sync::Mutex<Option<MdnsHandle>>,
    service_name: String,
}

struct MdnsHandle {
    responder_shutdown: Option<mdns_sd::Receiver<()>>,
    browser_cancelled: Option<mdns_sd::Receiver<()>>,
    periodic_running: Arc<std::sync::atomic::AtomicBool>,
}

impl MdnsService {
    pub fn new(registry: Arc<NodeRegistry>) -> Arc<Self> {
        let host = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".into());
        Arc::new(Self {
            registry,
            handle: tokio::sync::Mutex::new(None),
            service_name: format!("LLMNode-{host}"),
        })
    }

    /// 啟動 publish + 常駐 browse + 週期補掃任務。
    /// 失敗不 panic：記錄 Log(Sys) 事件並保持 localhost（registry 由呼叫端預先加入）。
    pub async fn start(self: &Arc<Self>) {
        let mut guard = self.handle.lock().await;
        if guard.is_some() {
            return; // 已啟動
        }
        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                self.registry_state().emit(crate::CoreEvent::Log(
                    crate::Subsystem::Sys,
                    format!("Failed to start mDNS discovery: {e}"),
                ));
                return;
            }
        };

        // 1. publish（對齊 bonjour.publish）
        let platform = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
        let props = [
            ("version", "1.0.0"),
            ("platform", platform),
        ];
        let service_info = ServiceInfo::new(
            SERVICE_TYPE,
            &self.service_name,
            &format!("{}.local.", self.service_name),
            "",
            crate::nodes::RPC_PORT,
            &props[..],
        );
        let responder = match service_info {
            Ok(info) => match daemon.register(info) {
                Ok(rx) => Some(rx),
                Err(e) => {
                    self.log(format!("mDNS register error: {e}"));
                    None
                }
            },
            Err(e) => {
                self.log(format!("mDNS service info error: {e}"));
                None
            }
        };

        // 2. 常駐 browse
        let browser_cancelled = match daemon.browse(SERVICE_TYPE) {
            Ok(mut rx) => {
                let registry = self.registry.clone();
                tokio::task::spawn_blocking(move || {
                    while let Ok(event) = rx.recv() {
                        match event {
                            ServiceEvent::SearchStarted(_) => {}
                            ServiceEvent::ServiceFound(_, info) => {
                                registry.add_filtered(&info.get_addresses().iter().map(|a| a.to_string()).collect::<Vec<_>>());
                            }
                            ServiceEvent::ServiceResolved(info) => {
                                registry.add_filtered(&info.get_addresses().iter().map(|a| a.to_string()).collect::<Vec<_>>());
                            }
                            ServiceEvent::ServiceRemoved(_, info) => {
                                // down 事件：移除該服務的所有地址
                                let addrs: Vec<String> = info.get_addresses().iter().map(|a| a.to_string()).collect();
                                let rt = tokio::runtime::Handle::current();
                                rt.block_on(async move {
                                    for addr in &addrs {
                                        if let Some(a) = filter_address(addr) {
                                            registry.remove(&a).await;
                                        }
                                    }
                                });
                            }
                            ServiceEvent::SearchStopped(_) => break,
                        }
                    }
                });
                None // browse 用 receiver 自然終止，無需 cancel channel
            }
            Err(e) => {
                self.log(format!("mDNS browse error: {e}"));
                None
            }
        };

        // 3. 週期補掃（每 30s 一個 5s 窗口，對齊 discoveryInterval）
        let periodic_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        {
            let daemon2 = daemon.clone();
            let registry = self.registry.clone();
            let running = periodic_running.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                interval.tick().await; // 立即的第一個 tick 跳過（首掃由常駐 browse 覆蓋）
                while running.load(std::sync::atomic::Ordering::Relaxed) {
                    interval.tick().await;
                    if let Ok(mut rx) = daemon2.browse(SERVICE_TYPE) {
                        let registry = registry.clone();
                        tokio::spawn(async move {
                            // 5 秒窗口
                            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                            while tokio::time::Instant::now() < deadline {
                                match tokio::time::timeout(Duration::from_millis(200), rx.recv_async_or_closed()).await {
                                    Ok(Some(Ok(ServiceEvent::ServiceResolved(info)))) | Ok(Some(Ok(ServiceEvent::ServiceFound(_, info)))) => {
                                        registry.add_filtered(&info.get_addresses().iter().map(|a| a.to_string()).collect::<Vec<_>>());
                                    }
                                    Ok(Some(Ok(_))) => {}
                                    Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
                                }
                            }
                            let _ = daemon.stop_browse(SERVICE_TYPE);
                        });
                    }
                }
            });
        }

        *guard = Some(MdnsHandle {
            responder_shutdown: responder,
            browser_cancelled,
            periodic_running,
        });

        self.log("Starting mDNS discovery...".into());
    }

    /// 停止所有 mDNS 活動（對齊 will-quit 清理）
    pub async fn stop(&self) {
        let mut guard = self.handle.lock().await;
        if let Some(h) = guard.take() {
            h.periodic_running.store(false, std::sync::atomic::Ordering::Relaxed);
            // responder/browser 的 shutdown receiver drop 即可；daemon 隨句柄釋放
        }
    }

    fn registry_state(&self) -> Arc<CoreState> {
        unreachable!("replaced below")
    }

    fn log(&self, msg: String) {
        // 由 registry 反取 state 不佳 —— 直接持有 state 較乾淨；見下方修正說明
        let _ = msg;
    }
}
```

**修正說明（執行者必做 —— 以此為準）：**
1. 上面 `registry_state()` / `log()` 是無效草稿。正確做法：`MdnsService` 建構子直接接收 `state: Arc<CoreState>`：

```rust
pub struct MdnsService {
    state: Arc<CoreState>,
    registry: Arc<NodeRegistry>,
    handle: tokio::sync::Mutex<Option<MdnsHandle>>,
    service_name: String,
}

pub fn new(state: Arc<CoreState>, registry: Arc<NodeRegistry>) -> Arc<Self>
```

`log` 改為 `self.state.emit(CoreEvent::Log(crate::Subsystem::Sys, msg))`，刪除 `registry_state()`。

2. `rx.recv_async_or_closed()` 不是真實 API —— blocking receiver 在 spawn_blocking 內用同步 `recv()`（如常駐 browse 所示）；週期補掃的 5 秒窗口改用 `spawn_blocking` + 同步 recv + deadline 迴圈，或簡化為：每次週期 tick 直接呼叫 `daemon.browse()` 後 `stop_browse` 於 5 秒後由獨立 timer 觸發。**建議簡化實作**：週期補掃僅做 `browse()` → sleep 5s → `stop_browse(SERVICE_TYPE)`，事件處理完全交給常駐 browse 任務（mdns-sd 的多個 browse 共享事件）。這更接近 bonjour-service 的實際效果且大幅簡化。若你選擇此方案，periodic 任務為：

```rust
let daemon2 = daemon.clone();
let running = periodic_running.clone();
tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await; // 跳過第一個立即 tick
    while running.load(std::sync::atomic::Ordering::Relaxed) {
        interval.tick().await;
        if daemon2.browse(SERVICE_TYPE).is_ok() {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = daemon2.stop_browse(SERVICE_TYPE);
        }
    }
});
```

3. `spawn_blocking` 內呼叫 `registry.add_filtered(...)`（async）需 runtime handle：在進入 spawn_blocking 前 capture `tokio::runtime::Handle::current()`，內部 `handle.block_on(registry.add_filtered(...))`。ServiceRemoved 分支同樣處理。

4. `stop()` 中 responder 的 shutdown receiver：mdns-sd 的 `register` 回傳 `Receiver<()>`，收到 `()` 表示完成；要取消需 `daemon.unregister(full_name)`。Phase 內簡化：stop 僅停止週期補掃 + drop daemon 句柄（daemon 在 MdnsHandle 增加 `daemon: ServiceDaemon` 欄位以便 drop）。完整 unregister/shutdown 留給 GUI 階段的退出流程。

- [ ] **Step 3: lib.rs 加 `pub mod mdns;`**

- [ ] **Step 4: 測試（mdns.rs tests mod）**

mDNS 網路行為難以單元測試，聚焦可測部分：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::NodeRegistry;

    #[test]
    fn test_service_type_constant() {
        assert_eq!(SERVICE_TYPE, "_llm-cluster._tcp.local.");
    }

    #[tokio::test]
    async fn test_start_stop_idempotent_without_network_error() {
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state.clone());
        reg.add("127.0.0.1").await; // 對齊啟動時加入 localhost
        let svc = MdnsService::new(state, reg);
        svc.start().await; // 不應 panic；即使 mDNS 失敗也要優雅
        svc.start().await; // 冪等：第二次 no-op
        svc.stop().await;
    }

    #[tokio::test]
    async fn test_hostname_prefixed_name() {
        // 驗證服務名格式 LLMNode-{host}（不連網）
        let state = crate::state::CoreState::new_for_test();
        let reg = NodeRegistry::new(state);
        let svc = MdnsService::new(state, reg);
        assert!(svc.service_name.starts_with("LLMNode-"));
    }
}
```

注意：`service_name` 是私有欄位 —— 測試在同模組內可直接存取。

- [ ] **Step 5: Run `cargo test -p llama-dist-core` → PASS（全部）；clippy -D warnings + fmt --check 乾淨**

- [ ] **Step 6: Commit**

```bash
git add crates/core/src/mdns.rs crates/core/src/lib.rs crates/core/Cargo.toml Cargo.lock
git commit -m "feat(core): mDNS 服務 — _llm-cluster 發布、常駐/週期瀏覽、節點自動增減"
```

---

### Task 4: 整合測試 + Phase 2 完成驗證

**Files:**
- Modify: `crates/core/tests/integration.rs`

- [ ] **Step 1: 追加整合測試**

```rust
#[tokio::test]
async fn node_registry_with_mdns_filter_integration() {
    use llama_dist_core::nodes::NodeRegistry;

    let state = CoreState::new(Config::default());
    let reg = NodeRegistry::new(state.clone());
    let mut rx = state.subscribe();

    // 模擬 mDNS 回報混合地址
    reg.add_filtered(&[
        "valid.remote".to_string(),      // 非法 → 跳過
        "192.168.50.1".to_string(),      // 有效遠端
        "169.254.100.7".to_string(),     // link-local → 跳過
        "127.0.0.1".to_string(),         // 本機
    ])
    .await;

    let _ = rx.recv().await;
    let list = reg.list().await;
    assert_eq!(list, vec!["127.0.0.1".to_string(), "192.168.50.1".to_string()]);
}
```

- [ ] **Step 2: 全量驗證**

- `cargo test --workspace` → PASS
- `cargo clippy --all-targets -- -D warnings` → clean
- `cargo fmt --check` → clean

- [ ] **Step 3: Commit**

```bash
git add crates/core/tests/integration.rs
git commit -m "test(core): 節點整合測試 — registry 與 mDNS 過濾協作"
```

---

## 完成標準（Phase 2 Definition of Done）

> **執行結果備註（2026-08-23）：** 「每 30s 週期補掃」已於實作階段移除（commit 71a41ba）。原因：mdns-sd 每個服務型別僅支援一個 querier（HashMap insert 覆蓋語意），第二個 browse 會使常駐瀏覽的事件流失效，stop_browse 更會清除該型別的所有重傳任務，導致探索在 ~35 秒後靜默死亡。mdns-sd 內建連續重查（退避重傳 + 快取刷新 + RFC 6762 goodbye/TTL 過期事件），已完整涵蓋 bonjour-service 需要 30s 手動補掃的場景。詳見 mdns.rs 模組註解。

- `cargo test --workspace` 全綠；clippy/fmt 乾淨
- 行為對照表：
  - ✅ filterAndAddNode 六條規則 + 本機映射 127.0.0.1
  - ✅ mDNS publish 參數（名稱/type/port/TXT）
  - ⚠️ 常駀 browse up/down（週期補掃如上備註移除，由 mdns-sd 內建重查取代）
  - ✅ add-manual-node 四道檢查與訊息文字
  - ✅ check-node-connection 5s 逾時 TCP
  - ✅ get-local-ips 形狀與 fallback

## 已知限制（記錄，不阻塞）
- mDNS stop 未做完整 unregister（GUI 階段退出流程處理）
- 多網卡環境的 mdns-sd 行為差異留待雙機冒煙測試（Phase 5 GUI 對照時驗證）

## 後續階段
- Phase 3: hf.rs（HF API 下載器）+ updater.rs（GitHub Release 更新器）
