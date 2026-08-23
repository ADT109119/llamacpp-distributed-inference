pub mod backend;
pub mod config;
pub mod error;
pub mod models;
pub mod paths;
pub mod process;
pub mod proxy;
pub mod rpc;
pub mod state;

pub use error::ApiError;

/// 系統日誌子系統
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subsystem {
    Node,
    Sys,
}

/// 核心事件：GUI / daemon / control 伺服器共用的唯一事件來源
#[derive(Debug, Clone)]
pub enum CoreEvent {
    NodeUpdate(Vec<String>),
    RpcServerStatus(bool),
    RpcServerLog(String),
    RpcServerError(String),
    ApiServerStatus {
        running: bool,
        message: String,
        loaded_model: Option<String>,
    },
    ApiServerLog(String),
    ApiServerError(String),
    DownloadProgress {
        percent: f64,
        message: String,
        current_file: String,
        kind: &'static str,
    },
    /// 系統日誌（node/sys 子系統）
    Log(Subsystem, String),
}
