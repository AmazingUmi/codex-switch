//! Direct-only acceptance through public service/startup boundaries.
//! All credentials are synthetic; no upstream request or listener is created.

use std::{
    ffi::OsString,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use codex_switch_lib::{
    get_codex_auth_path, get_codex_config_path,
    live::engine::DeviceStore,
    mode::{controller, current, state as mode_state},
    update_settings, AppSettings, AppState, AppType, Database, Provider, ProviderMeta,
    ProviderService,
};
use serde_json::{json, Value};

// A fresh home per case prevents other integration-test processes from deleting
// these fixtures. The mutex also protects process-global settings/environment.
struct TempHome {
    _directory: tempfile::TempDir,
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl TempHome {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut overrides = vec![
            ("CODEX_SWITCH_TEST_HOME", directory.path().to_path_buf()),
            ("HOME", directory.path().to_path_buf()),
        ];
        if cfg!(windows) {
            overrides.push(("USERPROFILE", directory.path().to_path_buf()));
            overrides.push(("LOCALAPPDATA", directory.path().join("AppData/Local")));
        }
        let previous = overrides
            .into_iter()
            .map(|(key, value)| {
                let previous = std::env::var_os(key);
                std::env::set_var(key, value);
                (key, previous)
            })
            .collect();
        update_settings(AppSettings::default()).unwrap();
        Self {
            _directory: directory,
            previous,
        }
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        for (key, previous) in &self.previous {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn test_mutex() -> &'static Mutex<()> {
    static MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    MUTEX.get_or_init(|| Mutex::new(()))
}

fn create_test_state() -> Result<AppState, Box<dyn std::error::Error>> {
    Ok(AppState::new(Arc::new(Database::init()?)))
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("CODEX_SWITCH_TEST_HOME").unwrap())
}

const LOGIN: &str = r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"synthetic-id","access_token":"synthetic-access","refresh_token":"synthetic-refresh","account_id":"synthetic-account"},"last_refresh":"2026-09-01T00:00:00Z"}"#;
const USER_CONFIG: &str = r#"# Keep the user's comment and native settings.
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.science]
command = "echo"
args = ["science"]

[projects."/synthetic/project"]
trust_level = "trusted"
"#;

fn write_home(relative: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
    let path = home().join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
}

fn provider(id: &str, key: &str, config: &str) -> Provider {
    Provider::with_id(
        id.into(),
        id.into(),
        json!({"auth": {"OPENAI_API_KEY": key}, "config": config}),
        None,
    )
}

fn official() -> Provider {
    let mut provider = Provider::with_id(
        "codex-official".into(),
        "OpenAI Official".into(),
        json!({"auth": {}, "config": "model = \"gpt-5\"\n"}),
        None,
    );
    provider.category = Some("official".into());
    provider
}

fn native_config(base: &str) -> String {
    format!(
        r#"model_provider = "deepseek"
model = "deepseek-v4-flash"
model_reasoning_effort = "xhigh"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "{base}"
wire_api = "responses"
requires_openai_auth = true
request_timeout_ms = 60000

[model_providers.deepseek.http_headers]
X-Team = "science"
"#
    )
}

fn native() -> Provider {
    let mut provider = provider(
        "deepseek",
        "synthetic-deepseek-key",
        &native_config("https://api.deepseek.com"),
    );
    provider.meta = Some(ProviderMeta {
        api_format: Some("openai_responses".into()),
        ..Default::default()
    });
    provider.settings_config["modelCatalog"] = json!({"models": [{
        "model": "deepseek-v4-flash", "displayName": "Native Flash",
        "reasoningLevels": ["none", "low", "high", "xhigh"],
        "defaultReasoningLevel": "xhigh"
    }]});
    provider
}

fn seed(state: &AppState, providers: &[Provider], selected: &str) {
    for provider in providers {
        state.db.save_provider("codex", provider).unwrap();
    }
    state.db.set_current_provider("codex", selected).unwrap();
}

fn live_text() -> String {
    fs::read_to_string(get_codex_config_path()).unwrap()
}

fn live() -> toml::Table {
    toml::from_str(&live_text()).unwrap()
}

fn assert_direct(state: &AppState, selected: &str) {
    assert_eq!(
        ProviderService::current(state, AppType::Codex).unwrap(),
        selected
    );
    assert_eq!(
        current::provider_for(&state.db, &AppType::Codex, current::Purpose::Direct).unwrap(),
        current::provider_for(&state.db, &AppType::Codex, current::Purpose::InUse).unwrap()
    );
    let mode = mode_state::mode_state(&DeviceStore::for_device(), "codex").unwrap();
    assert_eq!(mode.mode, Some(mode_state::Mode::Direct));
    assert!(!mode.attached);
    assert!(mode.proxy_route.is_none());
    assert!(mode.contract.is_none());
    assert_eq!(state.db.get_proxy_flags_sync("codex"), (false, false));
    let config = live();
    if let Some(id) = config.get("model_provider").and_then(toml::Value::as_str) {
        if let Some(table) = config
            .get("model_providers")
            .and_then(|tables| tables.get(id))
        {
            assert_ne!(
                table
                    .get("experimental_bearer_token")
                    .and_then(toml::Value::as_str),
                Some("PROXY_MANAGED")
            );
            assert_ne!(
                table.get("base_url").and_then(toml::Value::as_str),
                Some("http://127.0.0.1:15721/v1")
            );
        }
    }
}

fn mark_legacy_takeover(state: &AppState, route: &str) {
    mode_state::update(&DeviceStore::for_device(), |live| {
        live.apps
            .entry("codex".into())
            .or_default()
            .set_mode_state(mode_state::ModeState {
                mode: Some(mode_state::Mode::Proxy),
                attached: true,
                proxy_route: Some(route.into()),
                contract: Some(mode_state::Contract {
                    version: 1,
                    key: "synthetic-old-router".into(),
                    exclusive: Default::default(),
                }),
            });
    })
    .unwrap();
    state.db.set_proxy_flags_sync("codex", true, true).unwrap();
}

fn legacy_live() -> String {
    format!(
        "model_provider = \"deepseek\"\nmodel = \"deepseek-v4-flash\"\n{USER_CONFIG}\n[model_providers.deepseek]\nname = \"Legacy routing\"\nbase_url = \"http://127.0.0.1:15721/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"PROXY_MANAGED\"\n"
    )
}

#[test]
fn unsupported_activation_does_not_mutate_credentials_config_or_current() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    let _home = TempHome::new();
    let state = create_test_state().unwrap();
    seed(&state, &[official()], "codex-official");
    write_home(".codex/config.toml", USER_CONFIG);
    write_home(".codex/auth.json", LOGIN);
    let mut targets = vec![
        provider(
            "chat-wire",
            "synthetic-key",
            &native_config("https://example.invalid")
                .replace("\"responses\"", "\"chat_completions\""),
        ),
        provider(
            "anthropic-wire",
            "synthetic-key",
            &native_config("https://example.invalid").replace("\"responses\"", "\"anthropic\""),
        ),
        provider(
            "placeholder-key",
            "PROXY_MANAGED",
            &native_config("https://example.invalid"),
        ),
        provider(
            "placeholder-token",
            "synthetic-key",
            &format!(
                "experimental_bearer_token = \"PROXY_MANAGED\"\n{}",
                native_config("https://example.invalid")
            ),
        ),
    ];
    for format in ["openai_chat", "anthropic"] {
        let mut target = native();
        target.id = format.into();
        target.meta.as_mut().unwrap().api_format = Some(format.into());
        targets.push(target);
    }
    for kind in ["github_copilot", "xai_oauth"] {
        let mut target = native();
        target.id = kind.into();
        target.meta.as_mut().unwrap().provider_type = Some(kind.into());
        targets.push(target);
    }
    for target in &targets {
        state.db.save_provider("codex", target).unwrap();
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(controller::startup(&state));
    let config_before = fs::read(get_codex_config_path()).unwrap();
    let auth_before = fs::read(get_codex_auth_path()).unwrap();
    let state_before = fs::read(DeviceStore::for_device().state_path()).unwrap();
    for target in targets {
        let row_before =
            serde_json::to_value(state.db.get_provider_by_id(&target.id, "codex").unwrap())
                .unwrap();
        let error = ProviderService::switch(&state, AppType::Codex, &target.id).unwrap_err();
        assert!(
            error.to_string().contains("Responses"),
            "{}: {error}",
            target.id
        );
        assert_eq!(
            fs::read(get_codex_config_path()).unwrap(),
            config_before,
            "{}",
            target.id
        );
        assert_eq!(
            fs::read(get_codex_auth_path()).unwrap(),
            auth_before,
            "{}",
            target.id
        );
        assert_eq!(
            fs::read(DeviceStore::for_device().state_path()).unwrap(),
            state_before,
            "{}",
            target.id
        );
        assert_eq!(
            serde_json::to_value(state.db.get_provider_by_id(&target.id, "codex").unwrap())
                .unwrap(),
            row_before,
            "{}",
            target.id
        );
        assert_direct(&state, "codex-official");
    }
}

#[test]
fn rejected_activation_does_not_publish_a_legacy_migration_first() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    let _home = TempHome::new();
    let state = create_test_state().unwrap();
    let target = provider(
        "legacy-chat",
        "synthetic-retired-key",
        &native_config("https://example.invalid").replace("\"responses\"", "\"chat_completions\""),
    );
    seed(&state, &[official(), target], "codex-official");
    write_home(".codex/config.toml", legacy_live());
    write_home(".codex/auth.json", LOGIN);
    mark_legacy_takeover(&state, "missing-route");
    let paths = [
        get_codex_config_path(),
        get_codex_auth_path(),
        DeviceStore::for_device().state_path(),
    ];
    let before = paths.clone().map(|path| fs::read(path).unwrap());
    ProviderService::switch(&state, AppType::Codex, "legacy-chat").unwrap_err();
    assert_eq!(paths.map(|path| fs::read(path).unwrap()), before);
    assert_eq!(
        ProviderService::current(&state, AppType::Codex).unwrap(),
        "codex-official"
    );
    assert_eq!(state.db.get_proxy_flags_sync("codex"), (true, true));
}

#[test]
fn api_switch_and_legacy_account_rejection_preserve_preferences_catalog_and_history() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    for preserve in [false, true] {
        let _home = TempHome::new();
        let scanner_root = home().join("token-scanner");
        fs::create_dir_all(&scanner_root).unwrap();
        update_settings(AppSettings {
            preserve_codex_official_auth_on_switch: preserve,
            codex_usage_source_dir: Some(scanner_root.to_string_lossy().into_owned()),
            ..Default::default()
        })
        .unwrap();
        let state = create_test_state().unwrap();
        seed(&state, &[official(), native()], "codex-official");
        write_home(".codex/config.toml", USER_CONFIG);
        write_home(".codex/auth.json", LOGIN);
        let history = [
            write_home(".codex/history.jsonl", b"synthetic history\n"),
            write_home(".codex/sessions/session.jsonl", b"synthetic token event\n"),
            write_home(
                ".codex/archived_sessions/old.jsonl",
                b"synthetic archived event\n",
            ),
            write_home(
                "token-scanner/sessions/usage.jsonl",
                b"independent scanner event\n",
            ),
        ];
        let history_before: Vec<Vec<u8>> =
            history.iter().map(|path| fs::read(path).unwrap()).collect();
        ProviderService::switch(&state, AppType::Codex, "deepseek").unwrap();
        assert_direct(&state, "deepseek");
        let config = live();
        assert_eq!(config["model"].as_str(), Some("deepseek-v4-flash"));
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("xhigh"));
        let table = &config["model_providers"][config["model_provider"].as_str().unwrap()];
        assert_eq!(table["wire_api"].as_str(), Some("responses"));
        assert_eq!(table["base_url"].as_str(), Some("https://api.deepseek.com"));
        assert_eq!(
            table["experimental_bearer_token"].as_str(),
            Some("synthetic-deepseek-key")
        );
        assert_eq!(table["request_timeout_ms"].as_integer(), Some(60000));
        assert_eq!(table["http_headers"]["X-Team"].as_str(), Some("science"));
        if preserve {
            assert_eq!(fs::read(get_codex_auth_path()).unwrap(), LOGIN.as_bytes());
        } else {
            assert!(!get_codex_auth_path().exists());
        }
        let catalog_pointer = PathBuf::from(config["model_catalog_json"].as_str().unwrap());
        let catalog_path = if catalog_pointer.is_absolute() {
            catalog_pointer
        } else {
            get_codex_config_path()
                .parent()
                .unwrap()
                .join(catalog_pointer)
        };
        let catalog_bytes = fs::read(&catalog_path).unwrap();
        let catalog: Value = serde_json::from_slice(&catalog_bytes).unwrap();
        assert_eq!(catalog["models"][0]["slug"], "deepseek-v4-flash");
        assert_eq!(catalog["models"][0]["default_reasoning_level"], "xhigh");
        assert_eq!(
            catalog["models"][0]["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|level| level["effort"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["none", "low", "high", "xhigh"]
        );
        assert_eq!(
            state
                .db
                .get_provider_by_id("deepseek", "codex")
                .unwrap()
                .unwrap()
                .settings_config["modelCatalog"]["models"][0]["model"],
            "deepseek-v4-flash"
        );
        let before_auth = fs::read(get_codex_auth_path()).ok();
        let before_config = live_text();
        assert!(ProviderService::switch(&state, AppType::Codex, "codex-official").is_err());
        assert_direct(&state, "deepseek");
        assert_eq!(fs::read(get_codex_auth_path()).ok(), before_auth);
        assert_eq!(live_text(), before_config);
        ProviderService::switch(&state, AppType::Codex, "deepseek").unwrap();
        assert_eq!(fs::read(catalog_path).unwrap(), catalog_bytes);
        for (path, before) in history.iter().zip(history_before) {
            assert_eq!(fs::read(path).unwrap(), before);
        }
        assert!(live_text().contains("# Keep the user's comment and native settings."));
        assert_eq!(live()["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(live()["sandbox_mode"].as_str(), Some("workspace-write"));
        assert_eq!(
            live()["mcp_servers"]["science"]["args"].as_array().unwrap()[0].as_str(),
            Some("science")
        );
        assert_eq!(
            live()["projects"]["/synthetic/project"]["trust_level"].as_str(),
            Some("trusted")
        );
    }
}

#[test]
fn startup_migrates_attached_supported_route_and_is_byte_stable_on_second_startup() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    let _home = TempHome::new();
    update_settings(AppSettings {
        preserve_codex_official_auth_on_switch: true,
        ..Default::default()
    })
    .unwrap();
    let state = create_test_state().unwrap();
    seed(&state, &[official(), native()], "codex-official");
    write_home(".codex/config.toml", legacy_live());
    write_home(".codex/auth.json", LOGIN);
    mark_legacy_takeover(&state, "deepseek");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(state.db.save_live_backup("codex", &json!({"auth": {"OPENAI_API_KEY": "stale-backup-key"}, "config": "model = \"stale\""}).to_string())).unwrap();
    runtime.block_on(controller::startup(&state));
    assert_direct(&state, "deepseek");
    let config = live();
    assert_eq!(
        config["model_providers"][config["model_provider"].as_str().unwrap()]
            ["experimental_bearer_token"]
            .as_str(),
        Some("synthetic-deepseek-key")
    );
    assert_eq!(fs::read(get_codex_auth_path()).unwrap(), LOGIN.as_bytes());
    assert!(!live_text().contains("stale-backup-key"));
    assert!(runtime
        .block_on(state.db.get_live_backup("codex"))
        .unwrap()
        .is_none());
    let before = [
        get_codex_config_path(),
        get_codex_auth_path(),
        DeviceStore::for_device().state_path(),
    ]
    .map(|path| fs::read(path).unwrap());
    runtime.block_on(controller::startup(&state));
    assert_direct(&state, "deepseek");
    let after = [
        get_codex_config_path(),
        get_codex_auth_path(),
        DeviceStore::for_device().state_path(),
    ]
    .map(|path| fs::read(path).unwrap());
    assert_eq!(before, after);
}

#[test]
fn startup_falls_back_to_safe_direct_or_clears_unusable_current_pointer() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    for safe_direct in [true, false] {
        let _home = TempHome::new();
        let state = create_test_state().unwrap();
        let bad = provider(
            "legacy-chat",
            "synthetic-retired-key",
            &native_config("https://example.invalid")
                .replace("\"responses\"", "\"chat_completions\""),
        );
        let mut safe_api = official();
        safe_api.settings_config["auth"] = json!({"OPENAI_API_KEY":"synthetic-openai-api-key"});
        seed(
            &state,
            &[safe_api, bad],
            if safe_direct {
                "codex-official"
            } else {
                "legacy-chat"
            },
        );
        write_home(".codex/config.toml", legacy_live());
        write_home(".codex/auth.json", br#"{"OPENAI_API_KEY":"PROXY_MANAGED"}"#);
        mark_legacy_takeover(
            &state,
            if safe_direct {
                "legacy-chat"
            } else {
                "missing-route"
            },
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(controller::startup(&state));
        assert_direct(&state, if safe_direct { "codex-official" } else { "" });
        assert!(fs::read(get_codex_auth_path())
            .ok()
            .is_none_or(|bytes| !String::from_utf8_lossy(&bytes).contains("PROXY_MANAGED")));
        if !safe_direct {
            assert!(state.db.get_current_provider("codex").unwrap().is_none());
        }
        assert_eq!(live()["approval_policy"].as_str(), Some("on-request"));
        let before = [
            get_codex_config_path(),
            get_codex_auth_path(),
            DeviceStore::for_device().state_path(),
        ]
        .map(|path| fs::read(path).ok());
        runtime.block_on(controller::startup(&state));
        let after = [
            get_codex_config_path(),
            get_codex_auth_path(),
            DeviceStore::for_device().state_path(),
        ]
        .map(|path| fs::read(path).ok());
        assert_eq!(before, after);
    }
}

#[test]
fn startup_preserves_a_user_native_localhost_gateway_without_takeover_markers() {
    let _guard = test_mutex().lock().unwrap_or_else(|e| e.into_inner());
    let _home = TempHome::new();
    let state = create_test_state().unwrap();
    let base_config = native_config("http://127.0.0.1:15721/v1");
    let (selector, tables) = base_config.split_once("[model_providers").unwrap();
    let custom_config = format!("{selector}{USER_CONFIG}\n[model_providers{tables}");
    let gateway = provider("local-gateway", "synthetic-local-key", &custom_config);
    seed(&state, &[gateway], "local-gateway");
    write_home(".codex/config.toml", &custom_config);
    write_home(".codex/auth.json", LOGIN);
    let config_before = fs::read(get_codex_config_path()).unwrap();
    let auth_before = fs::read(get_codex_auth_path()).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(controller::startup(&state));
    runtime.block_on(controller::startup(&state));
    assert_eq!(
        ProviderService::current(&state, AppType::Codex).unwrap(),
        "local-gateway"
    );
    assert_eq!(state.db.get_proxy_flags_sync("codex"), (false, false));
    assert_eq!(fs::read(get_codex_config_path()).unwrap(), config_before);
    assert_eq!(fs::read(get_codex_auth_path()).unwrap(), auth_before);
}
