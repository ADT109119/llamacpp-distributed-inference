use crate::backend::BackendManager;
use crate::config::ServerOptions;
use crate::error::ApiError;
use crate::state::CoreState;
use crate::CoreEvent;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use std::path::PathBuf;
use std::sync::Arc;

const PROXY_PORT: u16 = 8080;

/// 解析請求的目標模型（對齊 startProxyServer 前段邏輯）。
/// requested: body.model；active: 目前載入中；opts_model: lastServerOptions
pub fn resolve_target(
    requested: Option<&str>,
    active: Option<&str>,
    opts_model: Option<&ServerOptions>,
    available: &[String],
) -> Result<Option<String>, ApiError> {
    if let Some(req) = requested.filter(|s| !s.is_empty()) {
        return match crate::models::match_model(available, req) {
            Some(m) => Ok(Some(m)),
            None => Err(ApiError {
                status: 404,
                code: "model_not_found",
                message: format!("找不到所要求的模型: \"{req}\"。請在儀表板下載並放置此模型。"),
            }),
        };
    }
    if active.is_some() {
        return Ok(active.map(String::from));
    }
    if let Some(o) = opts_model {
        if !o.model_name.is_empty() && available.contains(&o.model_name) {
            return Ok(Some(o.model_name.clone()));
        }
    }
    Ok(None)
}

/// 模型切換前的三道檢查（restrict / memory limit / autoload）。
/// size_of: 模型大小查詢（回傳 bytes），測試注入固定值，生產注入 fs metadata。
pub fn check_switch(
    target: &str,
    active: Option<&str>,
    opts: &ServerOptions,
    size_of: &dyn Fn(&str) -> Option<u64>,
) -> Result<(), ApiError> {
    if Some(target) == active {
        return Ok(());
    }
    if opts.restrict_single_model {
        let locked = active.map(String::from).unwrap_or_else(|| opts.model_name.clone());
        if !locked.is_empty() && target != locked {
            return Err(ApiError {
                status: 400,
                code: "model_switching_restricted",
                message: format!(
                    "API 伺服器已設定為限制運行單一模型，不允許動態切換。目前指定模型為 \"{locked}\"，而請求的模型是 \"{target}\"。"
                ),
            });
        }
    }
    if opts.max_memory_limit > 0 {
        if let Some(size) = size_of(target) {
            let gb = opts.max_memory_limit as u64 * 1024 * 1024 * 1024;
            if size > gb {
                return Err(ApiError {
                    status: 400,
                    code: "memory_limit_exceeded",
                    message: format!(
                        "模型 \"{target}\" 的大小({:.2} GB) 超出設定的記憶體上限限制 ({} GB)。",
                        size as f64 / (1024.0 * 1024.0 * 1024.0),
                        opts.max_memory_limit
                    ),
                });
            }
        }
    }
    if !opts.auto_load_enabled && active.is_none() {
        return Err(ApiError {
            status: 400,
            code: "auto_load_disabled",
            message: format!("即時模型載入 (On-demand loading) 已停用。請在主面板選擇模型\"{target}\"。"),
        });
    }
    Ok(())
}

fn error_response(err: &ApiError) -> Response {
    let body = serde_json::to_string(&err.body()).unwrap_or_default();
    Response::builder()
        .status(StatusCode::from_u16(err.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

/// 代理伺服器（axum :8080）
pub struct ProxyServer {
    state: Arc<CoreState>,
    backend: Arc<BackendManager>,
    idle_notify: Arc<tokio::sync::Notify>,
}

impl ProxyServer {
    pub fn new(
        state: Arc<CoreState>,
        backend: Arc<BackendManager>,
        idle_notify: Arc<tokio::sync::Notify>,
    ) -> Arc<Self> {
        Arc::new(Self { state, backend, idle_notify })
    }

    /// 啟動並監聽 0.0.0.0:8080；shutdown receiver 收到 true 後 graceful 結束。
    pub async fn run(
        self: Arc<Self>,
        shutdown: tokio::sync::watch::Receiver<bool>,
        options: ServerOptions,
        models_dir: PathBuf,
    ) -> Result<(), String> {
        let models = crate::models::scan_or_init_models_dir(&models_dir)
            .map_err(|e| e.to_string())?;

        let ctx = ProxyCtx {
            me: self.clone(),
            options: Arc::new(tokio::sync::RwLock::new(options)),
            models: Arc::new(tokio::sync::RwLock::new(models)),
            models_dir,
        };

        let router = axum::Router::new().fallback(handle_all).with_state(ctx);

        let listener = tokio::net::TcpListener::bind(("0.0.0.0", PROXY_PORT))
            .await
            .map_err(|e| format!("Failed to start API Proxy Server: {e}"))?;

        self.state.emit(CoreEvent::ApiServerStatus {
            running: true,
            message: "待機中 (未載入模型)".into(),
            loaded_model: None,
        });

        let mut shutdown = shutdown;
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown.changed().await;
            })
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 閒置計時重置：每次請求呼叫一次
    pub(crate) fn touch_idle(&self) {
        self.idle_notify.notify_one();
    }
}

#[derive(Clone)]
struct ProxyCtx {
    me: Arc<ProxyServer>,
    options: Arc<tokio::sync::RwLock<ServerOptions>>,
    models: Arc<tokio::sync::RwLock<Vec<String>>>,
    models_dir: PathBuf,
}

async fn handle_all(State(ctx): State<ProxyCtx>, req: Request) -> Response {
    ctx.me.touch_idle();

    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return error_response(&ApiError {
                status: 500,
                code: "internal",
                message: format!("Proxy internal error: {e}"),
            });
        }
    };

    // 解析 JSON body 的 model 欄位（僅 application/json；解析失敗忽略）
    let requested: Option<String> = parts
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .filter(|ct| ct.contains("application/json"))
        .and_then(|_| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("model").and_then(|m| m.as_str().map(String::from)));

    let active = ctx.me.backend.active_model().await;
    let opts = ctx.options.read().await.clone();
    let available = ctx.models.read().await.clone();

    let target =
        match resolve_target(requested.as_deref(), active.as_deref(), Some(&opts), &available) {
            Ok(t) => t,
            Err(e) => return error_response(&e),
        };

    if let Some(t) = target {
        if Some(&t) != active.as_ref() {
            let models_dir = ctx.models_dir.clone();
            let size_of = move |name: &str| -> Option<u64> {
                std::fs::metadata(models_dir.join(name)).ok().map(|m| m.len())
            };
            if let Err(e) = check_switch(&t, active.as_deref(), &opts, &size_of) {
                return error_response(&e);
            }
            ctx.me.state.emit(CoreEvent::ApiServerLog(format!(
                "[閒置管理] 偵測到請求指定模型\"{t}\"，開始自動載入...\n"
            )));
            if let Err(e) = ctx.me.backend.load_model(&t, &opts).await {
                return error_response(&ApiError {
                    status: 500,
                    code: "load_failed",
                    message: e,
                });
            }
        }
    }

    // 轉發（無 backend 可轉 → 503 no_active_model）
    let port = match ctx.me.backend.active_port().await {
        Some(p) => p,
        None => {
            return error_response(&ApiError {
                status: 503,
                code: "no_active_model",
                message: "推理引擎尚未啟動，或自動載入失敗。".into(),
            });
        }
    };

    let uri: Uri = parts.uri.clone();
    forward(
        format!("http://127.0.0.1:{port}{uri}"),
        parts.method,
        parts.headers,
        bytes.to_vec(),
    )
    .await
}

async fn forward(
    url: String,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
) -> Response {
    let client = reqwest::Client::new();
    let mut req = client.request(method, &url);
    for (k, v) in headers.iter() {
        if k != axum::http::header::HOST && k != axum::http::header::CONTENT_LENGTH {
            if let Ok(vs) = v.to_str() {
                req = req.header(k.as_str(), vs);
            }
        }
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status();
            let mut builder = Response::builder().status(status);
            for (k, v) in res.headers().iter() {
                if let Ok(vs) = v.to_str() {
                    builder = builder.header(k.as_str(), vs);
                }
            }
            let bytes = res.bytes().await.unwrap_or_default();
            builder.body(Body::from(bytes)).unwrap_or_else(|_| {
                error_response(&ApiError {
                    status: 502,
                    code: "bad_gateway",
                    message: "上游回應轉換失敗".into(),
                })
            })
        }
        Err(e) => error_response(&ApiError {
            status: 502,
            code: "bad_gateway",
            message: format!("內部代理轉發錯誤: {e}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerOptions;

    fn files() -> Vec<String> {
        vec!["A-Q4.gguf".into(), "B-Q4.gguf".into()]
    }

    #[test]
    fn resolve_uses_requested_when_matched() {
        let t = resolve_target(Some("B-Q4"), None, None, &files());
        assert_eq!(t.unwrap(), Some("B-Q4.gguf".into()));
    }

    #[test]
    fn resolve_not_found_error() {
        let t = resolve_target(Some("nope"), None, None, &files());
        let err = t.unwrap_err();
        assert_eq!(err.status, 404);
        assert_eq!(err.code, "model_not_found");
    }

    #[test]
    fn resolve_falls_back_to_options_model() {
        let o = ServerOptions { model_name: "A-Q4.gguf".into(), ..Default::default() };
        let t = resolve_target(None, None, Some(&o), &files());
        assert_eq!(t.unwrap(), Some("A-Q4.gguf".into()));
    }

    #[test]
    fn resolve_none_when_no_active_no_option() {
        let t = resolve_target(None, None, None, &files());
        assert_eq!(t.unwrap(), None);
    }

    #[test]
    fn switch_same_model_allowed() {
        let o = ServerOptions {
            restrict_single_model: true,
            auto_load_enabled: false,
            ..Default::default()
        };
        let size_of = |_: &str| -> Option<u64> { None };
        assert!(check_switch("A-Q4.gguf", Some("A-Q4.gguf"), &o, &size_of).is_ok());
    }

    #[test]
    fn switch_restrict_blocked() {
        let o = ServerOptions {
            restrict_single_model: true,
            ..Default::default()
        };
        let size_of = |_: &str| -> Option<u64> { None };
        let err = check_switch("B-Q4.gguf", Some("A-Q4.gguf"), &o, &size_of).unwrap_err();
        assert_eq!(err.code, "model_switching_restricted");
        assert_eq!(err.status, 400);
    }

    #[test]
    fn switch_autoload_disabled_blocked() {
        let o = ServerOptions {
            auto_load_enabled: false,
            ..Default::default()
        };
        let size_of = |_: &str| -> Option<u64> { None };
        let err = check_switch("B-Q4.gguf", None, &o, &size_of).unwrap_err();
        assert_eq!(err.code, "auto_load_disabled");
    }

    #[test]
    fn switch_memory_limit_blocked() {
        let o = ServerOptions {
            max_memory_limit: 1,
            ..Default::default()
        }; // 1GB
        let size_of = |_: &str| -> Option<u64> { Some(2 * 1024 * 1024 * 1024) }; // 每個模型 2GB
        let err = check_switch("B-Q4.gguf", None, &o, &size_of).unwrap_err();
        assert_eq!(err.code, "memory_limit_exceeded");
        assert_eq!(err.status, 400);
    }
}
