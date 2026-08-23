use llama_dist_core::{config::Config, state::CoreState};

#[tokio::test]
async fn config_and_event_bus_integration() {
    let cfg = Config {
        api_key: "it".into(),
        ..Config::default()
    };
    let state = CoreState::new(cfg.clone());
    let got = state.config().await;
    assert_eq!(got.api_key, "it");

    let mut rx = state.subscribe();
    state.emit(llama_dist_core::CoreEvent::ApiServerLog("hi".into()));
    assert!(rx.recv().await.is_ok());

    // update_config 後讀回
    let cfg2 = Config {
        theme: "dark".into(),
        ..Config::default()
    };
    state.update_config(cfg2).await;
    assert_eq!(state.config().await.theme, "dark");
}

#[test]
fn models_match_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("Test-Model-Q4.gguf");
    std::fs::write(&p, b"x").unwrap();
    let files = llama_dist_core::models::scan_or_init_models_dir(dir.path()).unwrap();
    assert_eq!(
        // 註：原計畫寫 "test model q4"（空格），但四級匹配（對齊 index.js
        // findMatchingModel）不會把連字號/空格互轉，故此處以大小寫無關精確匹配驗證端到端流程。
        llama_dist_core::models::match_model(&files, "test-model-q4"),
        Some("Test-Model-Q4.gguf".into())
    );
}

#[test]
fn api_error_body_serializable_end_to_end() {
    use llama_dist_core::ApiError;
    let err = ApiError {
        status: 503,
        code: "no_active_model",
        message: "x".into(),
    };
    let json = serde_json::to_value(err.body()).unwrap();
    assert_eq!(json["error"]["code"], "no_active_model");
}

#[test]
fn server_options_from_frontend_payload_shape() {
    // 模擬前端 app.js 送出的 payload 形狀（camelCase）可直接反序列化
    let payload = r#"{
        "modelName": "qwen.gguf",
        "apiKey": "",
        "rpcNodes": ["192.168.1.5"],
        "ngl": 33,
        "np": 1,
        "ctxSize": 4096,
        "flashAttention": true,
        "cacheTypeK": "f16",
        "cacheTypeV": "f16",
        "specEnabled": false,
        "draftModel": "",
        "draftNgl": 0,
        "draftMax": 0,
        "draftMin": 0,
        "draftPMin": 0.0,
        "idleTimeout": 5,
        "autoLoadEnabled": true,
        "maxMemoryLimit": 0,
        "restrictSingleModel": false,
        "cudaDeviceId": "",
        "cpuThreads": 0
    }"#;
    let opts: llama_dist_core::config::ServerOptions = serde_json::from_str(payload).unwrap();
    assert_eq!(opts.model_name, "qwen.gguf");
    assert_eq!(opts.idle_timeout, 5);
    assert!(opts.auto_load_enabled);
}

#[tokio::test]
async fn node_registry_with_mdns_filter_integration() {
    use llama_dist_core::nodes::NodeRegistry;

    let state = CoreState::new(Config::default());
    let reg = NodeRegistry::new(state.clone());
    let mut rx = state.subscribe();

    // 模擬 mDNS 回報混合地址
    reg.add_filtered(&[
        "valid.remote".to_string(),  // 非法 → 跳過
        "198.51.100.1".to_string(),  // 有效遠端（TEST-NET-2，避免與執行機器網卡同網段）
        "169.254.100.7".to_string(), // link-local → 跳過
        "127.0.0.1".to_string(),     // 本機
    ])
    .await;

    let ev = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("event within 2s")
        .expect("channel open");
    assert!(matches!(ev, llama_dist_core::CoreEvent::NodeUpdate(_)));
    let list = reg.list().await;
    assert_eq!(
        list,
        vec!["127.0.0.1".to_string(), "198.51.100.1".to_string()]
    );
}
