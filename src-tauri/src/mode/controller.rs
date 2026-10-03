//! Direct connection switching and one-way migration of historical local takeover state.
//! The independent switch lock and multi-file write engine remain responsible for credential safety.

use super::current::{self, Purpose};
use super::operation;
use super::state::{self, op, Contract, Mode, ModeState, PendingTarget};
use crate::app_config::AppType;
use crate::error::AppError;
use crate::live::engine::DeviceStore;
use crate::live::project::claude::{direct_patch, ClaudeProjection, PROXY_TOKEN_PLACEHOLDER};
use crate::live::project::gemini::GeminiProjection;
use crate::live::project::grok::GrokProjection;
use crate::provider::Provider;
use crate::services::provider::codex_direct::{self, Owner};
use crate::services::provider::{claude_direct, gemini_direct, grok_direct};
use crate::store::AppState;
use serde_json::{json, Value};
use tokio::sync::OwnedMutexGuard;

pub const LIVE_SWITCH_APPS: [AppType; 4] = [
    AppType::Claude,
    AppType::Codex,
    AppType::Gemini,
    AppType::GrokBuild,
];

/// 客户端文件现在对应的是谁。
enum LiveNow {
    /// 直连投影（或还没写过任何东西）。
    Direct(Option<Provider>),
    /// 代理契约；`route` 是写入契约时的路由供应商。
    Proxy {
        contract: Option<Contract>,
        route: Option<Provider>,
    },
}

impl LiveNow {
    /// live 里现在由哪个供应商带进来的独有字段。
    fn claude_exclusive_owner(&self) -> Option<ClaudeProjection> {
        match self {
            Self::Direct(provider) => provider
                .as_ref()
                .map(|provider| ClaudeProjection::of(&provider.settings_config)),
            Self::Proxy {
                contract: Some(contract),
                ..
            } => Some(ClaudeProjection {
                exclusive: contract.exclusive.clone(),
                ..ClaudeProjection::default()
            }),
            Self::Proxy {
                contract: None,
                route,
            } => route
                .as_ref()
                .map(|provider| ClaudeProjection::of(&provider.settings_config)),
        }
    }

    /// Codex 的 live 现在是谁写进去的。
    fn codex_owner(&self) -> Owner<'_> {
        match self {
            Self::Direct(provider) => provider.as_ref().map_or(Owner::None, Owner::Provider),
            Self::Proxy {
                contract: Some(contract),
                route,
            } => Owner::Contract {
                contract,
                route: route.as_ref(),
            },
            Self::Proxy {
                contract: None,
                route,
            } => route.as_ref().map_or(Owner::None, Owner::Provider),
        }
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn direct_provider(state: &AppState, app: &AppType) -> Result<Option<Provider>, String> {
    current::direct_provider(&state.db, app).map_err(err)
}

fn route_provider(
    state: &AppState,
    app: &AppType,
    mode: &ModeState,
) -> Result<Option<Provider>, String> {
    match mode.proxy_route.as_deref() {
        Some(id) => state.db.get_provider_by_id(id, app.as_str()).map_err(err),
        None => Ok(None),
    }
}

/// Commit device-local migration state without changing native files.
fn commit_state(state: &AppState, app: &AppType, target: &PendingTarget) -> Result<(), String> {
    operation::commit_target(&state.db, &DeviceStore::for_device(), app.as_str(), target)
        .map_err(err)
}

/// 写回直连投影（直连指针的供应商）。
fn write_direct(
    state: &AppState,
    app: &AppType,
    op_name: &str,
    live_now: &LiveNow,
    selected: Option<Provider>,
    rewrite: bool,
    target: ModeState,
) -> Result<(), String> {
    let direct = selected;
    let pending_target = PendingTarget {
        pointer: direct.as_ref().map(|provider| provider.id.clone()),
        clear_pointer: direct.is_none(),
        state: Some(target),
        ..PendingTarget::default()
    };
    let attached = rewrite || matches!(live_now, LiveNow::Proxy { .. });
    match app {
        AppType::Claude => {
            let empty = ClaudeProjection::default();
            let projection = usable_direct(app, direct.as_ref())
                .map(|provider| ClaudeProjection::of(&provider.settings_config));
            let patch = direct_patch(
                live_now.claude_exclusive_owner().as_ref(),
                projection.as_ref().unwrap_or(&empty),
            );
            claude_direct::run(
                &state.db,
                op_name,
                attached.then_some(&patch),
                pending_target,
            )
            .map_err(err)?;
        }
        AppType::Codex => {
            if !attached {
                commit_state(state, app, &pending_target)?;
                return Ok(());
            }
            let target = usable_direct(app, direct.as_ref());
            let owner = live_now.codex_owner();
            if let Err(error) = codex_direct::write_direct(
                &state.db,
                &state.codex_oauth_manager,
                op_name,
                owner,
                target,
                pending_target.clone(),
            ) {
                if operation::has_pending(app.as_str()) {
                    return Err(err(error));
                }
                // 直连供应商写不出来（比如绑定的托管账号已被删除）也不能让客户端一直指着
                // 代理：退一步只清空关键字段。
                log::warn!("写回直连的 Codex 配置失败，只清空关键字段: {error}");
                codex_direct::write_direct(
                    &state.db,
                    &state.codex_oauth_manager,
                    op_name,
                    owner,
                    None,
                    PendingTarget {
                        pointer: None,
                        clear_pointer: true,
                        ..pending_target
                    },
                )
                .map_err(err)?;
            }
        }
        AppType::Gemini => {
            let projection = attached.then(|| {
                direct_or_empty(
                    app,
                    direct.as_ref(),
                    gemini_direct::projection,
                    GeminiProjection::empty,
                )
            });
            gemini_direct::run(&state.db, op_name, projection.as_ref(), pending_target)
                .map_err(err)?;
        }
        AppType::GrokBuild => {
            let projection = attached.then(|| {
                direct_or_empty(app, direct.as_ref(), grok_direct::projection, || {
                    GrokProjection { table: None }
                })
            });
            grok_direct::run(
                &state.db,
                op_name,
                None,
                projection.as_ref(),
                pending_target,
            )
            .map_err(err)?;
        }
        _ => return Err(format!("{} 不支持本地路由", app.as_str())),
    }
    Ok(())
}

/// 直连供应商的投影。写不出来（没有、行里带着占位符、缺 Key）也不能让客户端一直指着
/// 代理：退一步只清空关键字段（`empty`）。
fn direct_or_empty<P>(
    app: &AppType,
    direct: Option<&Provider>,
    project: impl FnOnce(&Provider) -> Result<P, AppError>,
    empty: impl FnOnce() -> P,
) -> P {
    usable_direct(app, direct)
        .map(project)
        .transpose()
        .unwrap_or_else(|error| {
            log::warn!(
                "写回直连的 {} 配置失败，只清空关键字段: {error}",
                app.as_str()
            );
            None
        })
        .unwrap_or_else(empty)
}

/// 能照写回 live 的直连供应商：行里本身带着占位符（旧版接管期间被导入的残留）的不行，
/// 否则客户端会一直指着已经不在的本地代理。
fn usable_direct<'a>(app: &AppType, direct: Option<&'a Provider>) -> Option<&'a Provider> {
    direct.filter(|provider| {
        let polluted = config_has_proxy_placeholder(app, &provider.settings_config);
        if polluted {
            log::warn!(
                "直连供应商 {} 的行里带着代理占位符，只清空关键字段",
                provider.id
            );
        }
        !polluted && (app != &AppType::Codex || codex_direct::ensure_direct(provider).is_ok())
    })
}

/// 旧版的接管备份行：不回放，转存到本机文件后删除。留着的话，降级后旧版启动时会把这份
/// 陈旧的快照写回客户端。
async fn drain_legacy_backup(state: &AppState, app: &AppType) -> bool {
    let backup = match state.db.get_live_backup(app.as_str()).await {
        Ok(Some(backup)) => backup,
        Ok(None) => return false,
        Err(error) => {
            log::warn!("读取 {} 的旧接管备份失败: {error}", app.as_str());
            return false;
        }
    };
    let dir = crate::config::get_default_app_config_dir()
        .join("backups")
        .join("proxy-live-backup");
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let path = dir.join(format!("{}-{stamp}.json", app.as_str()));
    let saved = serde_json::to_vec_pretty(&json!({
        "app": app.as_str(),
        "backedUpAt": backup.backed_up_at,
        "originalConfig": serde_json::from_str::<Value>(&backup.original_config)
            .unwrap_or(Value::String(backup.original_config.clone())),
    }))
    .map_err(err)
    .and_then(|bytes| {
        std::fs::create_dir_all(&dir).map_err(err)?;
        crate::config::atomic_write_private(&path, &bytes).map_err(err)
    });
    match saved {
        Ok(()) => {
            if let Err(error) = state.db.delete_live_backup(app.as_str()).await {
                log::warn!("删除 {} 的旧接管备份失败: {error}", app.as_str());
            } else {
                log::info!(
                    "{} 的旧接管备份已转存到 {} 并从数据库删除",
                    app.as_str(),
                    path.display()
                );
            }
        }
        Err(error) => log::warn!(
            "转存 {} 的旧接管备份失败，保留数据库里的备份行: {error}",
            app.as_str()
        ),
    }
    true
}

/// The selected direct connection.
pub fn direct_provider_id(state: &AppState, app: &AppType) -> Result<Option<String>, AppError> {
    current::provider_for(&state.db, app, Purpose::Direct)
}

/// Historical takeover markers are recognized only for migration and import rejection.
pub(crate) fn config_has_proxy_placeholder(app: &AppType, config: &Value) -> bool {
    match app {
        AppType::Claude => config
            .get("env")
            .and_then(Value::as_object)
            .is_some_and(|env| {
                [
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "OPENROUTER_API_KEY",
                    "OPENAI_API_KEY",
                ]
                .iter()
                .any(|key| env.get(*key).and_then(Value::as_str) == Some(PROXY_TOKEN_PLACEHOLDER))
            }),
        AppType::Gemini => {
            config
                .pointer("/env/GEMINI_API_KEY")
                .and_then(Value::as_str)
                == Some(PROXY_TOKEN_PLACEHOLDER)
        }
        AppType::Codex => {
            config
                .pointer("/auth/OPENAI_API_KEY")
                .and_then(Value::as_str)
                == Some(PROXY_TOKEN_PLACEHOLDER)
                || config
                    .get("config")
                    .and_then(Value::as_str)
                    .is_some_and(|text| {
                        crate::codex_config::extract_codex_experimental_bearer_token(text)
                            .as_deref()
                            == Some(PROXY_TOKEN_PLACEHOLDER)
                            || crate::codex_config::codex_config_has_official_proxy_route(text)
                    })
        }
        AppType::GrokBuild => config
            .get("config")
            .and_then(Value::as_str)
            .is_some_and(|text| {
                crate::grok_config::has_proxy_placeholder(text, PROXY_TOKEN_PLACEHOLDER)
            }),
        _ => false,
    }
}

pub(crate) fn live_has_proxy_placeholder(app: &AppType) -> bool {
    crate::services::provider::read_live_settings(app.clone())
        .is_ok_and(|config| config_has_proxy_placeholder(app, &config))
}

/// Serialize direct writes and settle interrupted publications before reading ownership.
pub(crate) async fn lock_settled(
    state: &AppState,
    app: &AppType,
) -> Result<OwnedMutexGuard<()>, AppError> {
    let guard = state.switch_locks.lock_for_app(app.as_str()).await;
    operation::settle(&state.db, app.as_str())?;
    if LIVE_SWITCH_APPS.contains(app) {
        migrate_app_locked(state, app)
            .await
            .map_err(AppError::Message)?;
    }
    Ok(guard)
}

pub(crate) fn lock_settled_blocking(
    state: &AppState,
    app: &AppType,
) -> Result<Option<OwnedMutexGuard<()>>, AppError> {
    if !LIVE_SWITCH_APPS.contains(app) {
        return Ok(None);
    }
    futures::executor::block_on(lock_settled(state, app)).map(Some)
}

async fn migrate_app_locked(state: &AppState, app: &AppType) -> Result<(), String> {
    let mode = state::mode_state(&DeviceStore::for_device(), app.as_str()).map_err(err)?;
    let placeholder = live_has_proxy_placeholder(app);
    let (enabled, failover) = state.db.get_proxy_flags_sync(app.as_str());
    if !mode.is_proxy() && !mode.attached && !placeholder && !enabled && !failover {
        if mode.mode != Some(Mode::Direct) || mode.contract.is_some() || mode.proxy_route.is_some()
        {
            commit_state(
                state,
                app,
                &PendingTarget::mode(ModeState {
                    mode: Some(Mode::Direct),
                    ..ModeState::default()
                }),
            )?;
        }
        drain_legacy_backup(state, app).await;
        return Ok(());
    }
    let direct = direct_provider(state, app)?;
    let route = route_provider(state, app, &mode)?;
    let selected = if mode.is_proxy() || enabled {
        usable_direct(app, route.as_ref())
            .or_else(|| usable_direct(app, direct.as_ref()))
            .cloned()
    } else {
        usable_direct(app, direct.as_ref()).cloned()
    };
    let changes_provider =
        selected.as_ref().map(|row| &row.id) != direct.as_ref().map(|row| &row.id);
    let live_now = if placeholder || mode.attached {
        LiveNow::Proxy {
            contract: mode.contract.clone(),
            route: route.or_else(|| direct.clone()),
        }
    } else {
        LiveNow::Direct(direct)
    };
    // A detached old route may differ from the old direct pointer. Preserve the last selected
    // usable connection, publishing its direct credentials and pointer in the same transaction.
    write_direct(
        state,
        app,
        op::EXIT,
        &live_now,
        selected,
        changes_provider,
        ModeState {
            mode: Some(Mode::Direct),
            ..ModeState::default()
        },
    )?;
    state
        .db
        .set_proxy_flags_sync(app.as_str(), false, false)
        .map_err(err)?;
    drain_legacy_backup(state, app).await;
    Ok(())
}

/// Upgrade always returns historical takeovers to direct connections and never starts a listener.
pub async fn startup(state: &AppState) {
    for app in LIVE_SWITCH_APPS {
        if let Err(error) = lock_settled(state, &app).await {
            log::error!(
                "Direct connection migration for {} failed: {error}",
                app.as_str()
            );
        }
    }
}

#[cfg(test)]
mod mode_tests {
    //! Direct write, ownership, editor and interrupted-publication safety checks.
    use super::*;
    use crate::database::Database;
    use crate::legacy_routing::ProxyConfig;
    use crate::live::engine::DeviceStore;
    use crate::mode::operation::failpoint;
    use crate::mode::state;
    use crate::services::provider::ProviderService;
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::ffi::OsString;
    use std::fs;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct Home {
        _dir: TempDir,
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl Home {
        fn new() -> Self {
            let dir = TempDir::new().expect("temp home");
            let saved = ["HOME", "USERPROFILE", "CODEX_SWITCH_TEST_HOME"]
                .into_iter()
                .map(|key| {
                    let old = std::env::var_os(key);
                    std::env::set_var(key, dir.path());
                    (key, old)
                })
                .collect();
            crate::settings::reload_settings().expect("reload settings");
            Self { _dir: dir, saved }
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            for (key, old) in self.saved.drain(..) {
                match old {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            let _ = crate::settings::reload_settings();
        }
    }

    fn claude(id: &str, url: &str, extra: Value) -> Provider {
        let mut env = json!({
            "ANTHROPIC_BASE_URL": url,
            "ANTHROPIC_AUTH_TOKEN": format!("sk-{id}"),
            "ANTHROPIC_MODEL": "claude-sonnet-4-6"
        });
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                env[key] = value.clone();
            }
        }
        Provider::with_id(
            id.to_string(),
            id.to_uppercase(),
            json!({ "env": env }),
            None,
        )
    }

    async fn state_with(app: AppType, rows: &[Provider], current: &str) -> AppState {
        let db = Arc::new(Database::memory().expect("memory db"));
        for row in rows {
            db.save_provider(app.as_str(), row).expect("save provider");
        }
        db.set_current_provider(app.as_str(), current)
            .expect("set current");
        crate::settings::set_current_provider(&app, Some(current)).expect("local current");
        db.update_proxy_config(ProxyConfig {
            listen_port: 0,
            ..Default::default()
        })
        .await
        .expect("ephemeral port");
        AppState::new(db)
    }

    fn settings_path() -> std::path::PathBuf {
        crate::config::get_claude_settings_path()
    }

    fn seed_settings(text: &str) {
        let path = settings_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn settings() -> Value {
        serde_json::from_slice(&fs::read(settings_path()).unwrap()).unwrap()
    }

    fn direct(state: &AppState, app: &AppType) -> Option<String> {
        current::provider_for(&state.db, app, Purpose::Direct).unwrap()
    }

    const USER_SETTINGS: &str = r#"{
  "hooks": {
    "Stop": []
  },
  "env": {
    "ANTHROPIC_BASE_URL": "https://a.example",
    "ANTHROPIC_AUTH_TOKEN": "sk-a",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "DISABLE_TELEMETRY": "1"
  },
  "permissions": {
    "allow": [
      "Bash"
    ]
  }
}
"#;

    /// 上一次的操作补不完（这里是落定状态失败）时，保存编辑器直接拒绝、行不动。否则按补完
    /// 之前的指针判断「b 不是当前供应商」只存了行，等那次操作补完 b 成了当前供应商，live
    /// 里却是它的旧 Key。
    #[tokio::test]
    #[serial]
    async fn nothing_is_saved_while_the_previous_write_cannot_be_finished() {
        let _home = Home::new();
        seed_settings(USER_SETTINGS);
        let state = state_with(
            AppType::Claude,
            &[
                claude("a", "https://a.example", json!({})),
                claude("b", "https://b.example", json!({})),
            ],
            "a",
        )
        .await;
        failpoint::crash_at(Some("published:0"));
        let interrupted = ProviderService::switch(&state, AppType::Claude, "b");
        failpoint::crash_at(None);
        assert!(interrupted.is_err());

        let mut row = state.db.get_provider_by_id("b", "claude").unwrap().unwrap();
        let base =
            ProviderService::editor_view(&state, AppType::Claude, &row.settings_config, None)
                .expect("view")
                .settings;
        let mut edited = base.clone();
        edited["env"]["ANTHROPIC_AUTH_TOKEN"] = json!("sk-b-new");
        row.settings_config = edited;
        failpoint::crash_at(Some("recover:target"));
        let refused = ProviderService::update_from_editor(
            &state,
            AppType::Claude,
            None,
            row,
            Some(crate::services::provider::EditorSave {
                base,
                draft: None,
                on_conflict: Default::default(),
            }),
        );
        failpoint::crash_at(None);
        refused.expect_err("refused while unsettled");
        let b_token = |state: &AppState| {
            state
                .db
                .get_provider_by_id("b", "claude")
                .unwrap()
                .unwrap()
                .settings_config["env"]["ANTHROPIC_AUTH_TOKEN"]
                .clone()
        };
        assert_eq!(b_token(&state), "sk-b", "the row is untouched");

        crate::mode::operation::recover_on_startup(&state.db);
        assert_eq!(direct(&state, &AppType::Claude).as_deref(), Some("b"));
        assert_eq!(settings()["env"]["ANTHROPIC_AUTH_TOKEN"], b_token(&state));
    }

    // ---------- Codex：只替换关键字段 ----------

    fn codex_row(id: &str, url: &str, extra: &str) -> Provider {
        Provider::with_id(
            id.to_string(),
            id.to_uppercase(),
            json!({
                "auth": { "OPENAI_API_KEY": format!("sk-{id}") },
                "config": format!(
                    "model_provider = \"{id}\"\nmodel = \"gpt-{id}\"\n{extra}\n[model_providers.{id}]\nname = \"{id}\"\nbase_url = \"{url}\"\nwire_api = \"responses\"\n"
                ),
            }),
            None,
        )
    }

    fn codex_official() -> Provider {
        let mut official = Provider::with_id(
            crate::database::CODEX_OFFICIAL_PROVIDER_ID.to_string(),
            "OpenAI Official".to_string(),
            json!({ "auth": {}, "config": "" }),
            None,
        );
        official.category = Some("official".to_string());
        official
    }

    fn switch_test_codex_account(
        state: &AppState,
    ) -> Result<crate::services::provider::CodexAccountSwitchResult, AppError> {
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    if state.codex_oauth_manager.account_label("acct").is_none() {
                        tauri::async_runtime::block_on(
                            state
                                .codex_oauth_manager
                                .add_test_account_with_user_identity(
                                    "acct",
                                    "access-acct",
                                    "test-user",
                                ),
                        )
                        .map_err(|error| AppError::Message(error.to_string()))?;
                    }
                    ProviderService::switch_codex_account(state, "acct")
                })
                .join()
                .unwrap()
        })
    }

    fn codex_config_path() -> std::path::PathBuf {
        crate::codex_config::get_codex_config_path()
    }

    fn codex_auth_path() -> std::path::PathBuf {
        crate::codex_config::get_codex_auth_path()
    }

    fn seed_codex(config: &str, auth: Option<&Value>) {
        let path = codex_config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, config).unwrap();
        match auth {
            Some(auth) => fs::write(codex_auth_path(), auth.to_string()).unwrap(),
            None => {
                let _ = fs::remove_file(codex_auth_path());
            }
        }
    }

    fn codex_text() -> String {
        fs::read_to_string(codex_config_path()).unwrap()
    }

    fn codex_doc() -> toml::Table {
        toml::from_str(&codex_text()).unwrap()
    }

    fn set_preservation(on: bool) {
        crate::settings::update_settings(crate::settings::AppSettings {
            preserve_codex_official_auth_on_switch: on,
            ..Default::default()
        })
        .unwrap();
    }

    fn chatgpt_login(account: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": "id",
                "access_token": format!("access-{account}"),
                "refresh_token": format!("refresh-{account}"),
                "account_id": account
            },
            "last_refresh": "2026-09-01T00:00:00Z"
        })
    }

    /// live 里 A 的关键字段之外，都是用户和 Codex 自己的东西。
    const CODEX_USER_LIVE: &str = r#"# 用户的注释
approval_policy = "on-request"
model_provider = "custom"
model = "gpt-a"
model_context_window = 200000

[projects."/work"]
trust_level = "trusted"

[agents]
default_subagent_model = "gpt-a-mini"
max_threads = 4

[model_providers.custom]
name = "a"
base_url = "https://a.example/v1"
wire_api = "responses"
experimental_bearer_token = "sk-a"

[model_providers.ollama_local]
name = "Ollama"
base_url = "http://localhost:11434/v1"

[mcp_servers.fs]
command = "fs-server"
"#;

    fn codex_a_b() -> [Provider; 2] {
        [
            codex_row(
                "a",
                "https://a.example/v1",
                "model_context_window = 200000\n[agents]\ndefault_subagent_model = \"gpt-a-mini\"\n",
            ),
            codex_row("b", "https://b.example/v1", ""),
        ]
    }

    /// 关键字段之外的部分（用户的表、注释、MCP、项目信任）。
    fn codex_user_parts(text: &str) -> Vec<&str> {
        [
            "# 用户的注释",
            "approval_policy = \"on-request\"",
            "[projects.\"/work\"]",
            "max_threads = 4",
            "[model_providers.ollama_local]",
            "[mcp_servers.fs]",
        ]
        .into_iter()
        .filter(|part| text.contains(part))
        .collect()
    }

    #[tokio::test]
    #[serial]
    async fn codex_direct_switch_replaces_only_key_fields_and_round_trips() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;

        ProviderService::switch(&state, AppType::Codex, "b").expect("switch to b");
        let on_b = codex_text();
        let doc = codex_doc();
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        assert_eq!(doc["model"].as_str(), Some("gpt-b"));
        let route = &doc["model_providers"]["custom"];
        assert_eq!(route["base_url"].as_str(), Some("https://b.example/v1"));
        assert_eq!(route["experimental_bearer_token"].as_str(), Some("sk-b"));
        assert!(!on_b.contains("sk-a"), "A's key is gone: {on_b}");
        // A 带进来的独有字段（值没被改过）删掉；嵌在 [agents] 里的模型名只删那一个键。
        assert!(doc.get("model_context_window").is_none(), "{on_b}");
        assert!(doc["agents"].get("default_subagent_model").is_none());
        assert_eq!(doc["agents"]["max_threads"].as_integer(), Some(4));
        assert_eq!(codex_user_parts(&on_b).len(), 6, "{on_b}");

        ProviderService::switch(&state, AppType::Codex, "a").expect("back to a");
        let on_a = codex_text();
        let doc = codex_doc();
        assert_eq!(doc["model"].as_str(), Some("gpt-a"));
        assert_eq!(doc["model_context_window"].as_integer(), Some(200000));
        assert_eq!(
            doc["agents"]["default_subagent_model"].as_str(),
            Some("gpt-a-mini")
        );
        assert_eq!(codex_user_parts(&on_a).len(), 6, "{on_a}");

        // 第二轮往返字节稳定。
        ProviderService::switch(&state, AppType::Codex, "b").expect("to b again");
        assert_eq!(codex_text(), on_b);
        ProviderService::switch(&state, AppType::Codex, "a").expect("to a again");
        assert_eq!(codex_text(), on_a);
    }

    #[tokio::test]
    #[serial]
    async fn codex_exclusive_fields_the_user_changed_stay() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
        let edited = CODEX_USER_LIVE.replace(
            "model_context_window = 200000",
            "model_context_window = 150000",
        );
        seed_codex(&edited, None);

        ProviderService::switch(&state, AppType::Codex, "b").expect("switch to b");
        assert_eq!(
            codex_doc()["model_context_window"].as_integer(),
            Some(150000),
            "a value the user changed is not A's to remove"
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_official_switch_removes_the_owned_route_table() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, Some(&chatgpt_login("acct")));
        let [a, b] = codex_a_b();
        let state = state_with(AppType::Codex, &[a, b, codex_official()], "a").await;

        switch_test_codex_account(&state).expect("switch to official");
        let text = codex_text();
        let doc = codex_doc();
        assert!(doc.get("model_provider").is_none(), "{text}");
        assert!(
            doc.get("model_providers")
                .and_then(|tables| tables.get("custom"))
                .is_none(),
            "{text}"
        );
        assert!(!text.contains("127.0.0.1:15721"), "{text}");
        assert!(!text.contains("sk-a"), "no real key stays behind: {text}");
        assert_eq!(codex_user_parts(&text).len(), 6, "{text}");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(codex_auth_path()).unwrap()).unwrap()
                ["tokens"]["access_token"],
            "access-acct",
            "the selected account credentials are published"
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_an_active_profile_overriding_the_route_is_refused_without_side_effects() {
        let _home = Home::new();
        set_preservation(true);
        let live = format!(
            "profile = \"work\"\n{CODEX_USER_LIVE}\n[profiles.work]\nmodel_provider = \"ollama_local\"\n"
        );
        seed_codex(&live, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
        let mtime = fs::metadata(codex_config_path())
            .unwrap()
            .modified()
            .unwrap();

        let err = ProviderService::switch(&state, AppType::Codex, "b").expect_err("refused");
        assert!(err.to_string().contains("work"), "{err}");
        assert_eq!(codex_text(), live);
        assert_eq!(
            fs::metadata(codex_config_path())
                .unwrap()
                .modified()
                .unwrap(),
            mtime
        );
        assert_eq!(direct(&state, &AppType::Codex).as_deref(), Some("a"));
    }

    /// 生效的 profile 显式选了内置的 `openai`：和官方卡不写 model_provider 去的是同一个
    /// 地方，切到官方卡不拒绝；切到第三方仍然拒绝。
    #[tokio::test]
    #[serial]
    async fn codex_a_profile_selecting_the_built_in_openai_allows_the_official_card() {
        let _home = Home::new();
        set_preservation(true);
        let live = format!(
            "profile = \"work\"\n{CODEX_USER_LIVE}\n[profiles.work]\nmodel_provider = \"openai\"\n"
        );
        seed_codex(&live, Some(&chatgpt_login("acct")));
        let [a, b] = codex_a_b();
        let state = state_with(AppType::Codex, &[a, b, codex_official()], "a").await;

        switch_test_codex_account(&state).expect("switch to official");
        let doc = codex_doc();
        assert!(doc.get("model_provider").is_none());
        assert_eq!(
            doc["profiles"]["work"]["model_provider"].as_str(),
            Some("openai")
        );

        let err = ProviderService::switch(&state, AppType::Codex, "b").expect_err("refused");
        assert!(err.to_string().contains("work"), "{err}");
    }

    #[tokio::test]
    #[serial]
    async fn codex_migration_retires_only_tables_codex_switch_wrote() {
        let _home = Home::new();
        set_preservation(true);
        // 旧版按行的 id 整份写进来的表：a（id 和地址都对得上 a 的行）、b 的地址被用户改过、
        // 被 profile 引用的 c、代理占位残留、用户自己的 ollama_local。
        let live = r#"model_provider = "a"
model = "gpt-a"

[model_providers.a]
name = "a"
base_url = "https://a.example/v1"
experimental_bearer_token = "sk-a"

[model_providers.b]
name = "b"
base_url = "https://my-own-b.example/v1"

[model_providers.c]
name = "c"
base_url = "https://c.example/v1"

[model_providers.deepseek]
name = "deepseek"
base_url = "http://127.0.0.1:15721/v1"
experimental_bearer_token = "PROXY_MANAGED"

[model_providers.ollama_local]
name = "Ollama"
base_url = "http://localhost:11434/v1"

[profiles.side]
model_provider = "c"
"#;
        seed_codex(live, None);
        let [a, b] = codex_a_b();
        let c = codex_row("c", "https://c.example/v1", "");
        let state = state_with(AppType::Codex, &[a, b, c], "a").await;

        ProviderService::switch(&state, AppType::Codex, "b").expect("switch to b");
        let text = codex_text();
        let providers = codex_doc()["model_providers"].as_table().unwrap().clone();
        assert!(!providers.contains_key("a"), "provably ours: {text}");
        assert!(
            !providers.contains_key("deepseek"),
            "placeholder leftover: {text}"
        );
        assert!(
            providers.contains_key("b"),
            "address differs, not provably ours"
        );
        assert!(providers.contains_key("c"), "a profile still selects it");
        assert!(
            providers.contains_key("ollama_local"),
            "the user's own table"
        );
        assert!(!text.contains("sk-a"), "{text}");
    }

    #[tokio::test]
    #[serial]
    async fn codex_switch_crash_rolls_every_file_forward() {
        let _home = Home::new();
        set_preservation(false);
        seed_codex(CODEX_USER_LIVE, Some(&chatgpt_login("acct")));
        let [a, mut b] = codex_a_b();
        b.settings_config["modelCatalog"] = json!({ "models": [{ "model": "gpt-b" }] });
        let state = state_with(AppType::Codex, &[a, b, codex_official()], "a").await;
        switch_test_codex_account(&state).expect("official");

        // 官方 → b：删 auth.json（暂存登录）、改 config.toml、写模型目录，一起提交。
        for point in ["published:0", "published:1", "published:2", "target"] {
            switch_test_codex_account(&state).expect("reset to official");
            assert!(codex_auth_path().exists(), "{point}: login restored");
            failpoint::crash_at(Some(point));
            let crashed = ProviderService::switch(&state, AppType::Codex, "b");
            failpoint::crash_at(None);
            assert!(crashed.is_err(), "{point}");

            crate::mode::operation::recover_on_startup(&state.db);
            assert!(!codex_auth_path().exists(), "{point}: auth.json deleted");
            assert_eq!(codex_doc()["model"].as_str(), Some("gpt-b"), "{point}");
            assert!(
                crate::codex_config::get_codex_model_catalog_path().exists(),
                "{point}: catalog written"
            );
            assert_eq!(
                direct(&state, &AppType::Codex).as_deref(),
                Some("b"),
                "{point}"
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn codex_preservation_off_gives_the_login_back_on_the_way_to_official() {
        let _home = Home::new();
        set_preservation(false);
        seed_codex("", Some(&chatgpt_login("acct")));
        let [a, b] = codex_a_b();
        let official = codex_official();
        let state = state_with(AppType::Codex, &[a, b, official.clone()], &official.id).await;
        let login = || -> Option<Value> {
            fs::read(codex_auth_path())
                .ok()
                .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        };

        ProviderService::switch(&state, AppType::Codex, "a").expect("to a");
        assert_eq!(login(), None, "no login next to a third-party route");
        ProviderService::switch(&state, AppType::Codex, "b").expect("to b");
        switch_test_codex_account(&state).expect("to official");
        assert_eq!(
            login().unwrap()["tokens"]["access_token"],
            "access-acct",
            "explicit account selection restores its own credentials"
        );
        let row = state
            .db
            .get_provider_by_id(&official.id, "codex")
            .unwrap()
            .unwrap();
        assert_eq!(
            row.settings_config["auth"],
            json!({}),
            "the login never goes into the row (it would sync to the cloud)"
        );

        // 在官方卡上登出后切走再切回：保持登出。
        fs::remove_file(codex_auth_path()).unwrap();
        ProviderService::switch(&state, AppType::Codex, "a").expect("to a");
        switch_test_codex_account(&state).expect("to official");
        assert_eq!(
            login().unwrap()["tokens"]["access_token"],
            "access-acct",
            "explicit account selection signs in again"
        );
    }

    fn codex_login_on_disk() -> Value {
        crate::config::read_json_file(&codex_auth_path()).unwrap()
    }

    /// 官方 → a：删掉 auth.json 之后失败。登录只在暂存的临时文件里，指针没动。
    async fn codex_switch_interrupted_after_auth_json() -> (AppState, Provider) {
        set_preservation(false);
        seed_codex(CODEX_USER_LIVE, Some(&chatgpt_login("acct")));
        let [a, b] = codex_a_b();
        let official = codex_official();
        let state = state_with(AppType::Codex, &[a, b, official.clone()], &official.id).await;
        switch_test_codex_account(&state).expect("official");
        failpoint::crash_at(Some("published:0"));
        let failed = ProviderService::switch(&state, AppType::Codex, "a");
        failpoint::crash_at(None);
        assert!(failed.is_err());
        assert!(!codex_auth_path().exists());
        assert_eq!(direct(&state, &AppType::Codex).as_deref(), None);
        (state, official)
    }

    #[tokio::test]
    #[serial]
    async fn codex_a_retry_after_a_failed_switch_finishes_it_first() {
        let _home = Home::new();
        let (state, _official) = codex_switch_interrupted_after_auth_json().await;

        // 重试切到 b：先补完到 a，再按补完后的 auth.json 和暂存从 a 切到 b。
        ProviderService::switch(&state, AppType::Codex, "b").expect("retry");
        assert_eq!(direct(&state, &AppType::Codex).as_deref(), Some("b"));
        assert_eq!(codex_doc()["model"].as_str(), Some("gpt-b"));
        switch_test_codex_account(&state).expect("to official");
        assert_eq!(
            codex_login_on_disk()["tokens"]["access_token"],
            "access-acct"
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_an_interrupted_switch_keeps_the_login_when_codex_changed_config_toml() {
        let _home = Home::new();
        let (state, _official) = codex_switch_interrupted_after_auth_json().await;
        // 补完之前 Codex 自己改了 config.toml（信任了一个新项目）。
        let mut text = codex_text();
        text.push_str("\n[projects.\"/new\"]\ntrust_level = \"trusted\"\n");
        fs::write(codex_config_path(), &text).unwrap();

        crate::mode::operation::recover_on_startup(&state.db);
        assert_eq!(
            direct(&state, &AppType::Codex).as_deref(),
            Some("a"),
            "the pointer follows the auth.json already deleted"
        );
        assert_eq!(codex_text(), text, "Codex's own change is left alone");
        switch_test_codex_account(&state).expect("to official");
        assert_eq!(
            codex_login_on_disk()["tokens"]["access_token"],
            "access-acct",
            "the selected account survives interrupted switching"
        );
    }

    /// 发布过的文件在补完之前又被客户端改掉（这里是用户在 Codex 里重新登录、写了新的
    /// auth.json）：单看文件分不出发布开始过没有，按 pending 里的「已开始发布」照样前滚，
    /// 还没写出去的登录暂存不能丢，客户端写的 auth.json 不动。
    #[tokio::test]
    #[serial]
    async fn codex_an_interrupted_switch_keeps_the_stash_when_the_published_file_changed_again() {
        let _home = Home::new();
        let (state, _official) = codex_switch_interrupted_after_auth_json().await;
        fs::write(codex_auth_path(), chatgpt_login("other").to_string()).unwrap();

        crate::mode::operation::recover_on_startup(&state.db);
        assert_eq!(direct(&state, &AppType::Codex).as_deref(), Some("a"));
        assert_eq!(codex_doc()["model"].as_str(), Some("gpt-a"));
        let stash = fs::read_to_string(DeviceStore::for_device().file("codex-login-stash.json"))
            .expect("the stash was published");
        assert!(stash.contains("refresh-acct"), "{stash}");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(codex_auth_path()).unwrap()).unwrap(),
            chatgpt_login("other")
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_an_unreadable_login_stash_is_never_overwritten() {
        let _home = Home::new();
        set_preservation(false);
        seed_codex(CODEX_USER_LIVE, Some(&chatgpt_login("acct")));
        let stash = DeviceStore::for_device().file("codex-login-stash.json");
        fs::create_dir_all(stash.parent().unwrap()).unwrap();
        let broken = br#"{"logins":{"account:old":{"tokens":{"refresh_token":"salvageable"}}},"#;
        fs::write(&stash, broken).unwrap();
        let [a, b] = codex_a_b();
        let official = codex_official();
        let state = state_with(AppType::Codex, &[a, b, official.clone()], &official.id).await;

        // 切到第三方要把 auth.json 里的登录存进暂存：停下，什么都不写。
        let err = ProviderService::switch(&state, AppType::Codex, "a").expect_err("refused");
        assert!(err.to_string().contains("codex-login-stash.json"), "{err}");
        assert_eq!(fs::read(&stash).unwrap(), broken);
        assert_eq!(
            codex_login_on_disk()["tokens"]["access_token"],
            "access-acct"
        );
        assert_eq!(codex_text(), CODEX_USER_LIVE);

        // 用不着暂存的切换照常。
        fs::remove_file(codex_auth_path()).unwrap();
        ProviderService::switch(&state, AppType::Codex, "b").expect("nothing to stash");
        assert_eq!(fs::read(&stash).unwrap(), broken);
    }

    #[tokio::test]
    #[serial]
    async fn claude_a_retry_after_a_failed_switch_removes_the_failed_targets_exclusive_fields() {
        let _home = Home::new();
        seed_settings(USER_SETTINGS);
        let a = claude("a", "https://a.example", json!({}));
        let b = claude(
            "b",
            "https://b.example",
            json!({ "CLAUDE_CODE_DISABLE_ARTIFACT": "1" }),
        );
        let c = claude("c", "https://c.example", json!({}));
        let state = state_with(AppType::Claude, &[a, b, c], "a").await;

        // 切到 b：settings.json 已经写好，指针落定前失败。
        failpoint::crash_at(Some("published:0"));
        let failed = ProviderService::switch(&state, AppType::Claude, "b");
        failpoint::crash_at(None);
        assert!(failed.is_err());
        assert_eq!(settings()["env"]["CLAUDE_CODE_DISABLE_ARTIFACT"], "1");
        assert_eq!(direct(&state, &AppType::Claude).as_deref(), Some("a"));

        // 重试切到 c：先补完到 b，再按 b 删它带进来的独有字段。
        ProviderService::switch(&state, AppType::Claude, "c").expect("retry");
        assert_eq!(direct(&state, &AppType::Claude).as_deref(), Some("c"));
        let env = &settings()["env"];
        assert_eq!(env["ANTHROPIC_BASE_URL"], "https://c.example");
        assert!(env.get("CLAUDE_CODE_DISABLE_ARTIFACT").is_none(), "{env}");
    }

    #[tokio::test]
    #[serial]
    async fn codex_keyring_logins_keep_requires_openai_auth_on_the_preservation_setting() {
        let _home = Home::new();
        for preserve in [true, false] {
            set_preservation(preserve);
            seed_codex("cli_auth_credentials_store = \"keyring\"\n", None);
            let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
            ProviderService::switch(&state, AppType::Codex, "b").expect("to b");
            let doc = codex_doc();
            assert_eq!(
                doc["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
                Some(preserve),
                "the login lives in the keyring, auth.json says nothing (preserve={preserve})"
            );
            assert_eq!(doc["cli_auth_credentials_store"].as_str(), Some("keyring"));
        }
    }

    #[tokio::test]
    #[serial]
    async fn codex_editor_saves_key_fields_to_the_row_and_global_edits_to_live() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
        let save = |id: &str, settings: Value, base: Value| {
            let mut row = state.db.get_provider_by_id(id, "codex").unwrap().unwrap();
            row.settings_config = settings;
            ProviderService::update_from_editor(
                &state,
                AppType::Codex,
                Some(id),
                row,
                Some(crate::services::provider::EditorSave {
                    base,
                    draft: None,
                    on_conflict: Default::default(),
                }),
            )
        };

        // 编辑非当前的 b：显示的是切到 b 之后的 config.toml（Key 在输入框里，不在 TOML 里）。
        let b_row = state.db.get_provider_by_id("b", "codex").unwrap().unwrap();
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &b_row.settings_config, None)
                .expect("view b");
        let shown = view.settings["config"].as_str().unwrap().to_string();
        assert!(
            shown.contains("gpt-b") && shown.contains("https://b.example/v1"),
            "{shown}"
        );
        assert!(!shown.contains("sk-b"), "{shown}");
        assert_eq!(codex_user_parts(&shown).len(), 6, "{shown}");

        let mut edited = view.settings.clone();
        edited["config"] = json!(
            shown
                .replace("\"on-request\"", "\"never\"")
                .replace("\"gpt-b\"", "\"gpt-b2\"")
                + "\n[mcp_servers.git]\ncommand = \"git\"\n"
        );
        save("b", edited, view.settings.clone()).expect("save b");
        let live = codex_text();
        assert!(
            live.contains("approval_policy = \"never\""),
            "global edit applied: {live}"
        );
        assert!(live.contains("[mcp_servers.git]"), "{live}");
        assert_eq!(
            codex_doc()["model"].as_str(),
            Some("gpt-a"),
            "b is not current: {live}"
        );
        let b_row = state.db.get_provider_by_id("b", "codex").unwrap().unwrap();
        let b_config = b_row.settings_config["config"].as_str().unwrap();
        assert!(
            b_config.contains("gpt-b2") && !b_config.contains("approval_policy"),
            "{b_config}"
        );

        // 编辑当前的 a：关键字段立刻换进 live。
        let a_row = state.db.get_provider_by_id("a", "codex").unwrap().unwrap();
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &a_row.settings_config, None)
                .expect("view a");
        let mut edited = view.settings.clone();
        edited["config"] = json!(view.settings["config"]
            .as_str()
            .unwrap()
            .replace("\"gpt-a\"", "\"gpt-a2\""));
        save("a", edited, view.settings.clone()).expect("save a");
        assert_eq!(codex_doc()["model"].as_str(), Some("gpt-a2"));
        assert!(codex_text().contains("[mcp_servers.git]"));

        // 打开编辑器之后别的程序改了同一个键：保存时报冲突，什么都不写。
        let a_row = state.db.get_provider_by_id("a", "codex").unwrap().unwrap();
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &a_row.settings_config, None)
                .expect("view a again");
        let outside = codex_text().replace("\"never\"", "\"untrusted\"");
        fs::write(codex_config_path(), &outside).unwrap();
        let mut edited = view.settings.clone();
        edited["config"] = json!(view.settings["config"]
            .as_str()
            .unwrap()
            .replace("\"never\"", "\"on-failure\""));
        let err = save("a", edited, view.settings.clone()).expect_err("conflict");
        assert!(
            err.to_string()
                .contains(crate::live::patch::EDIT_CONFLICT_CODE),
            "{err}"
        );
        assert_eq!(codex_text(), outside);
    }

    /// live 里用户自己写的独有字段（`model_verbosity` 这类）不归当前供应商：原样保存不会
    /// 把它收进行，切走时也就不会删掉；在编辑器里删掉它就从 live 删；新加的独有字段归
    /// 供应商。
    #[tokio::test]
    #[serial]
    async fn codex_editor_leaves_exclusive_fields_from_live_to_the_user() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(
            &CODEX_USER_LIVE.replace(
                "model = \"gpt-a\"\n",
                "model = \"gpt-a\"\nmodel_verbosity = \"high\"\nmodel_supports_reasoning_summaries = true\n",
            ),
            None,
        );
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
        let open = |id: &str| {
            let row = state.db.get_provider_by_id(id, "codex").unwrap().unwrap();
            let view =
                ProviderService::editor_view(&state, AppType::Codex, &row.settings_config, None)
                    .expect("view");
            (row, view.settings)
        };
        let save = |mut row: Provider, edited: Value, base: Value| {
            row.settings_config = edited;
            ProviderService::update_from_editor(
                &state,
                AppType::Codex,
                None,
                row,
                Some(crate::services::provider::EditorSave {
                    base,
                    draft: None,
                    on_conflict: Default::default(),
                }),
            )
        };
        let a_config = |state: &AppState| {
            state
                .db
                .get_provider_by_id("a", "codex")
                .unwrap()
                .unwrap()
                .settings_config["config"]
                .as_str()
                .unwrap()
                .to_string()
        };

        // 只改名、配置原样保存。
        let (mut row, base) = open("a");
        row.name = "renamed".into();
        save(row, base.clone(), base).expect("save as is");
        let config = a_config(&state);
        assert!(
            config.contains("model_context_window = 200000")
                && !config.contains("model_verbosity")
                && !config.contains("model_supports_reasoning_summaries"),
            "{config}"
        );

        // 删掉一个从 live 带进来的，再加一个供应商自己的。
        let (row, base) = open("a");
        let mut edited = base.clone();
        edited["config"] = json!(base["config"]
            .as_str()
            .unwrap()
            .replace("model_supports_reasoning_summaries = true\n", "")
            .replace(
                "model_verbosity",
                "model_auto_compact_token_limit = 100000\nmodel_verbosity"
            ));
        save(row, edited, base).expect("save edits");
        let live = codex_text();
        assert!(
            !live.contains("model_supports_reasoning_summaries")
                && live.contains("model_auto_compact_token_limit = 100000"),
            "{live}"
        );
        let config = a_config(&state);
        assert!(
            config.contains("model_auto_compact_token_limit = 100000")
                && !config.contains("model_verbosity"),
            "{config}"
        );

        ProviderService::switch(&state, AppType::Codex, "b").expect("switch to b");
        let live = codex_doc();
        assert_eq!(live["model_verbosity"].as_str(), Some("high"));
        assert!(live.get("model_auto_compact_token_limit").is_none());
        assert!(live.get("model_context_window").is_none());
    }

    /// 打开编辑器之后客户端改了一个从 live 带进来的独有字段：用户没动它，保存时不收进行，
    /// 也不把打开时的值写回去。live 里生效的 profile 选着路由表时，编辑和新增都照样能存。
    #[tokio::test]
    #[serial]
    async fn codex_editor_leaves_what_the_user_did_not_touch_to_the_client() {
        let _home = Home::new();
        set_preservation(true);
        let live = CODEX_USER_LIVE.replace(
            "model = \"gpt-a\"\n",
            "model = \"gpt-a\"\nmodel_verbosity = \"high\"\n",
        );
        seed_codex(
            &format!("profile = \"work\"\n{live}\n[profiles.work]\nmodel_provider = \"custom\"\n"),
            None,
        );
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;

        let mut row = state.db.get_provider_by_id("a", "codex").unwrap().unwrap();
        let base = ProviderService::editor_view(&state, AppType::Codex, &row.settings_config, None)
            .expect("view")
            .settings;
        let changed =
            codex_text().replace("model_verbosity = \"high\"", "model_verbosity = \"low\"");
        fs::write(codex_config_path(), &changed).unwrap();
        row.name = "renamed".into();
        row.settings_config = base.clone();
        ProviderService::update_from_editor(
            &state,
            AppType::Codex,
            None,
            row,
            Some(crate::services::provider::EditorSave {
                base,
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("save with the profile active");
        let doc = codex_doc();
        assert_eq!(
            doc["model_verbosity"].as_str(),
            Some("low"),
            "{}",
            codex_text()
        );
        assert_eq!(
            doc["profiles"]["work"]["model_provider"].as_str(),
            Some("custom")
        );
        let stored = state.db.get_provider_by_id("a", "codex").unwrap().unwrap();
        assert!(!stored.settings_config["config"]
            .as_str()
            .unwrap()
            .contains("model_verbosity"));

        let draft = codex_row("c", "https://c.example/v1", "");
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &draft.settings_config, None)
                .expect("draft view");
        add_from_editor(
            &state,
            AppType::Codex,
            draft,
            view.settings.clone(),
            view.settings,
        )
        .expect("add with the profile active");
    }

    /// 新增对话框打开之后，客户端改了一个从 live 带进来的独有字段：草稿里没有它，保存时不
    /// 收进新供应商，切到新供应商再切走，客户端改的值还在。预设自己带的独有字段照样归新
    /// 供应商。
    #[tokio::test]
    #[serial]
    async fn codex_add_dialog_leaves_a_live_field_changed_after_opening_to_the_client() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(
            &CODEX_USER_LIVE.replace(
                "model = \"gpt-a\"\n",
                "model = \"gpt-a\"\nmodel_verbosity = \"high\"\n",
            ),
            None,
        );
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;
        let config_of = |id: &str| {
            state
                .db
                .get_provider_by_id(id, "codex")
                .unwrap()
                .unwrap()
                .settings_config["config"]
                .as_str()
                .unwrap()
                .to_string()
        };

        let draft = codex_row(
            "c",
            "https://c.example/v1",
            "model_auto_compact_token_limit = 90000",
        );
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &draft.settings_config, None)
                .expect("draft view");
        let changed =
            codex_text().replace("model_verbosity = \"high\"", "model_verbosity = \"low\"");
        fs::write(codex_config_path(), changed).unwrap();
        add_from_editor(
            &state,
            AppType::Codex,
            draft,
            view.settings.clone(),
            view.settings,
        )
        .expect("add c");
        let stored = config_of("c");
        assert!(
            stored.contains("model_auto_compact_token_limit = 90000")
                && !stored.contains("model_verbosity"),
            "{stored}"
        );
        ProviderService::switch(&state, AppType::Codex, "c").expect("to c");
        ProviderService::switch(&state, AppType::Codex, "b").expect("to b");
        assert_eq!(codex_doc()["model_verbosity"].as_str(), Some("low"));

        // 旧的调用方不带草稿：退回和 live 里用户自己的值比（live 没被改过时分得清）。
        let mut legacy = codex_row(
            "d",
            "https://d.example/v1",
            "model_auto_compact_token_limit = 80000",
        );
        let base =
            ProviderService::editor_view(&state, AppType::Codex, &legacy.settings_config, None)
                .expect("legacy view")
                .settings;
        legacy.settings_config = base.clone();
        ProviderService::add_from_editor(
            &state,
            AppType::Codex,
            legacy,
            true,
            Some(crate::services::provider::EditorSave {
                base,
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("add d");
        let stored = config_of("d");
        assert!(
            stored.contains("model_auto_compact_token_limit = 80000")
                && !stored.contains("model_verbosity"),
            "{stored}"
        );
    }

    /// 编辑器里把路由表从 custom 改名成别的表：那张表归供应商（按内容收成 custom 表），
    /// 不当成全局设置写进 live，切走后表和里面的 Key 都不会留下。
    #[tokio::test]
    #[serial]
    async fn codex_editor_route_table_renamed_in_the_editor_stays_with_the_provider() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;

        let mut row = state.db.get_provider_by_id("a", "codex").unwrap().unwrap();
        let view = ProviderService::editor_view(&state, AppType::Codex, &row.settings_config, None)
            .expect("view a");
        let shown = view.settings["config"].as_str().unwrap();
        assert!(shown.contains("[model_providers.custom]\n"), "{shown}");
        let mut edited = view.settings.clone();
        edited["config"] = json!(shown
            .replace(
                "model_provider = \"custom\"",
                "model_provider = \"deepseek\""
            )
            .replace(
                "[model_providers.custom]\n",
                "[model_providers.deepseek]\nexperimental_bearer_token = \"sk-secret\"\n",
            ));
        row.settings_config = edited;
        ProviderService::update_from_editor(
            &state,
            AppType::Codex,
            None,
            row,
            Some(crate::services::provider::EditorSave {
                base: view.settings,
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("save");
        let live = codex_text();
        assert!(!live.contains("[model_providers.deepseek]"), "{live}");
        assert!(live.contains("[model_providers.ollama_local]"), "{live}");

        ProviderService::switch(&state, AppType::Codex, "b").expect("switch to b");
        let live = codex_text();
        assert!(
            !live.contains("sk-secret") && !live.contains("deepseek"),
            "{live}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn codex_a_login_refreshed_during_the_switch_is_never_overwritten() {
        let _home = Home::new();
        set_preservation(false);
        seed_codex("", Some(&chatgpt_login("acct")));
        let [a, _] = codex_a_b();
        let official = codex_official();
        let state = state_with(AppType::Codex, &[a, official.clone()], &official.id).await;
        let config_before = codex_text();

        // 计划删掉 auth.json 之后、发布之前，Codex CLI 刷新了登录。
        let mut refreshed = chatgpt_login("acct");
        refreshed["tokens"]["refresh_token"] = json!("refresh-acct-2");
        let fresh = refreshed.to_string();
        failpoint::on_before_publish(Some(Box::new(move |_, path: &std::path::Path| {
            if path == codex_auth_path() {
                fs::write(path, &fresh).unwrap();
            }
        })));
        let result = ProviderService::switch(&state, AppType::Codex, "a");
        failpoint::on_before_publish(None);

        assert!(
            result.is_err(),
            "the switch stops instead of deleting a newer login"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(codex_auth_path()).unwrap()).unwrap(),
            refreshed
        );
        assert_eq!(codex_text(), config_before, "nothing else was published");
        assert_eq!(
            direct(&state, &AppType::Codex).as_deref(),
            Some(official.id.as_str())
        );
        assert!(
            state::pending(&DeviceStore::for_device(), "codex")
                .unwrap()
                .is_none(),
            "an operation that never published leaves no pending"
        );
    }

    // ===== Gemini CLI =====

    const GEMINI_USER_ENV: &str = "# my notes\nGEMINI_SANDBOX=docker\nGEMINI_API_KEY=key-a\nDEBUG=1\nGOOGLE_GEMINI_BASE_URL=https://a.example\nGEMINI_MODEL=m-a\n";
    const GEMINI_USER_SETTINGS: &str = r#"{
  "model": {
    "name": "m-a",
    "compressionThreshold": 0.5
  },
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  },
  "mcpServers": {
    "fs": {
      "command": "fs"
    }
  }
}
"#;

    fn gemini_env_path() -> std::path::PathBuf {
        crate::gemini_config::get_gemini_env_path()
    }

    fn gemini_settings_path() -> std::path::PathBuf {
        crate::gemini_config::get_gemini_settings_path()
    }

    fn seed_gemini(env: &str, settings: &str) {
        fs::create_dir_all(gemini_env_path().parent().unwrap()).unwrap();
        fs::write(gemini_env_path(), env).unwrap();
        fs::write(gemini_settings_path(), settings).unwrap();
    }

    fn gemini_env() -> String {
        fs::read_to_string(gemini_env_path()).unwrap()
    }

    fn gemini_settings() -> Value {
        serde_json::from_slice(&fs::read(gemini_settings_path()).unwrap()).unwrap()
    }

    /// `.env` 里用户自己的行（注释、非关键字段），按原顺序。
    fn gemini_user_lines(text: &str) -> Vec<String> {
        text.lines()
            .filter(|line| {
                line.split_once('=')
                    .is_none_or(|(key, _)| !crate::live::floor::gemini_floor_env(key.trim()))
            })
            .map(str::to_string)
            .collect()
    }

    fn gemini(id: &str, env: Value, config: Value) -> Provider {
        Provider::with_id(
            id.to_string(),
            id.to_uppercase(),
            json!({ "env": env, "config": config }),
            None,
        )
    }

    fn gemini_a_vertex() -> [Provider; 2] {
        [
            gemini(
                "a",
                json!({
                    "GEMINI_API_KEY": "key-a",
                    "GOOGLE_GEMINI_BASE_URL": "https://a.example",
                    "GEMINI_MODEL": "m-a"
                }),
                json!({ "model": { "name": "m-a" } }),
            ),
            gemini(
                "vertex",
                json!({
                    "GOOGLE_GENAI_USE_VERTEXAI": "true",
                    "GOOGLE_CLOUD_PROJECT": "p"
                }),
                json!({}),
            ),
        ]
    }

    #[tokio::test]
    #[serial]
    async fn gemini_switch_replaces_only_key_fields_and_round_trips() {
        let _home = Home::new();
        seed_gemini(GEMINI_USER_ENV, GEMINI_USER_SETTINGS);
        let state = state_with(AppType::Gemini, &gemini_a_vertex(), "a").await;

        ProviderService::switch(&state, AppType::Gemini, "vertex").expect("to vertex");
        assert_eq!(
            gemini_env(),
            "# my notes\nGEMINI_SANDBOX=docker\nDEBUG=1\nGOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=p\n"
        );
        assert_eq!(
            gemini_settings(),
            json!({
                "model": { "compressionThreshold": 0.5 },
                "security": { "auth": { "selectedType": "gemini-api-key" } },
                "mcpServers": { "fs": { "command": "fs" } }
            })
        );

        ProviderService::switch(&state, AppType::Gemini, "a").expect("back to a");
        let env = gemini_env();
        assert_eq!(gemini_user_lines(&env), gemini_user_lines(GEMINI_USER_ENV));
        for line in [
            "GEMINI_API_KEY=key-a",
            "GOOGLE_GEMINI_BASE_URL=https://a.example",
            "GEMINI_MODEL=m-a",
        ] {
            assert!(env.contains(line), "{env}");
        }
        assert!(!env.contains("VERTEX"), "{env}");
        assert_eq!(
            gemini_settings(),
            serde_json::from_str::<Value>(GEMINI_USER_SETTINGS).unwrap()
        );
        assert_eq!(direct(&state, &AppType::Gemini).as_deref(), Some("a"));
    }

    #[tokio::test]
    #[serial]
    async fn gemini_official_switch_selects_the_google_login() {
        let _home = Home::new();
        seed_gemini(GEMINI_USER_ENV, GEMINI_USER_SETTINGS);
        let [a, _] = gemini_a_vertex();
        let mut official = gemini("google", json!({}), json!({}));
        official.category = Some("official".to_string());
        let state = state_with(AppType::Gemini, &[a, official], "a").await;

        ProviderService::switch(&state, AppType::Gemini, "google").expect("to official");
        assert_eq!(gemini_env(), "# my notes\nGEMINI_SANDBOX=docker\nDEBUG=1\n");
        assert_eq!(
            gemini_settings()["security"]["auth"]["selectedType"],
            json!("oauth-personal")
        );
        assert!(gemini_settings()["model"].get("name").is_none());
    }

    #[tokio::test]
    #[serial]
    async fn gemini_editor_saves_key_fields_to_the_row_and_global_edits_to_live() {
        let _home = Home::new();
        seed_gemini(GEMINI_USER_ENV, GEMINI_USER_SETTINGS);
        let state = state_with(AppType::Gemini, &gemini_a_vertex(), "a").await;

        let a = state.db.get_provider_by_id("a", "gemini").unwrap().unwrap();
        let view = ProviderService::editor_view(&state, AppType::Gemini, &a.settings_config, None)
            .expect("view");
        assert_eq!(view.settings["env"]["GEMINI_SANDBOX"], json!("docker"));
        assert_eq!(
            view.settings["config"]["mcpServers"]["fs"]["command"],
            json!("fs")
        );

        let mut edited = view.settings.clone();
        edited["env"]["GEMINI_API_KEY"] = json!("key-a2");
        edited["env"]["DEBUG"] = json!("2");
        edited["config"]["ui"] = json!({ "theme": "dark" });
        let mut row = a.clone();
        row.settings_config = edited;
        ProviderService::update_from_editor(
            &state,
            AppType::Gemini,
            Some("a"),
            row,
            Some(crate::services::provider::EditorSave {
                base: view.settings.clone(),
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("save");

        let env = gemini_env();
        assert!(
            env.contains("GEMINI_API_KEY=key-a2") && env.contains("DEBUG=2"),
            "{env}"
        );
        assert_eq!(gemini_settings()["ui"], json!({ "theme": "dark" }));
        let saved = state.db.get_provider_by_id("a", "gemini").unwrap().unwrap();
        assert_eq!(
            saved.settings_config["env"]["GEMINI_API_KEY"],
            json!("key-a2")
        );
        assert!(saved.settings_config["env"].get("DEBUG").is_none());
        assert!(saved.settings_config["config"].get("ui").is_none());

        // 编辑非当前的 vertex：live 的关键字段不动，全局改动照写。
        let vertex = state
            .db
            .get_provider_by_id("vertex", "gemini")
            .unwrap()
            .unwrap();
        let view =
            ProviderService::editor_view(&state, AppType::Gemini, &vertex.settings_config, None)
                .expect("view vertex");
        assert!(view.settings["env"].get("GEMINI_API_KEY").is_none());
        let mut edited = view.settings.clone();
        edited["env"]["GOOGLE_CLOUD_PROJECT"] = json!("p2");
        edited["env"]["DEBUG"] = json!("3");
        let mut row = vertex.clone();
        row.settings_config = edited;
        ProviderService::update_from_editor(
            &state,
            AppType::Gemini,
            Some("vertex"),
            row,
            Some(crate::services::provider::EditorSave {
                base: view.settings,
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("save vertex");
        let env = gemini_env();
        assert!(
            env.contains("GEMINI_API_KEY=key-a2") && env.contains("DEBUG=3"),
            "{env}"
        );
        assert!(!env.contains("GOOGLE_CLOUD_PROJECT"), "{env}");
        let saved = state
            .db
            .get_provider_by_id("vertex", "gemini")
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.settings_config["env"]["GOOGLE_CLOUD_PROJECT"],
            json!("p2")
        );
    }

    // ===== Grok Build =====

    const GROK_USER_LIVE: &str = "# mine\n[ui]\ntheme = \"dark\"\n\n[model.mine]\nmodel = \"m\"\nname = \"Mine\"\n\n[mcp_servers.fs]\ncommand = \"fs\"\n";

    fn grok_path() -> std::path::PathBuf {
        crate::grok_config::get_grok_config_path()
    }

    fn seed_grok(text: &str) {
        fs::create_dir_all(grok_path().parent().unwrap()).unwrap();
        fs::write(grok_path(), text).unwrap();
    }

    fn grok_text() -> String {
        fs::read_to_string(grok_path()).unwrap()
    }

    fn grok_doc() -> toml::Table {
        toml::from_str(&grok_text()).unwrap()
    }

    /// live 里的 `[model.*]` 表名（排好序）。
    fn grok_tables() -> Vec<String> {
        grok_doc()
            .get("model")
            .and_then(|model| model.as_table())
            .map(|tables| tables.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn grok_row(id: &str, table: &str, extra: &str) -> Provider {
        Provider::with_id(
            id.to_string(),
            id.to_uppercase(),
            json!({ "config": format!(
                "[models]\ndefault = \"{table}\"\n\n[model.\"{table}\"]\nmodel = \"{id}-model\"\nname = \"{id}\"\nbase_url = \"https://{id}.example/v1\"\napi_key = \"key-{id}\"\napi_backend = \"responses\"\ncontext_window = 500000\n{extra}"
            ) }),
            None,
        )
    }

    fn grok_official() -> Provider {
        let mut official = Provider::with_id(
            "grok-official".to_string(),
            "Grok Official".to_string(),
            json!({ "config": "" }),
            None,
        );
        official.category = Some("official".to_string());
        official
    }

    #[tokio::test]
    #[serial]
    async fn grok_switch_deletes_the_written_table_even_after_the_client_changed_the_default() {
        let _home = Home::new();
        seed_grok(GROK_USER_LIVE);
        let state = state_with(
            AppType::GrokBuild,
            &[grok_row("a", "grok-4.5", ""), grok_official()],
            "grok-official",
        )
        .await;

        ProviderService::switch(&state, AppType::GrokBuild, "a").expect("to a");
        assert_eq!(grok_doc()["models"]["default"].as_str(), Some("grok-4.5"));
        assert_eq!(grok_tables(), vec!["grok-4.5", "mine"]);

        // Grok 的 /settings 把默认模型改成了内置的 grok-4.6。
        let changed = grok_text().replace("default = \"grok-4.5\"", "default = \"grok-4.6\"");
        fs::write(grok_path(), changed).unwrap();

        ProviderService::switch(&state, AppType::GrokBuild, "grok-official").expect("to official");
        assert_eq!(grok_tables(), vec!["mine"], "{}", grok_text());
        assert!(grok_doc().get("models").is_none(), "{}", grok_text());
        assert!(grok_text().starts_with("# mine\n[ui]\ntheme = \"dark\"\n"));

        // 切回去照样能用。
        ProviderService::switch(&state, AppType::GrokBuild, "a").expect("back to a");
        assert_eq!(grok_tables(), vec!["grok-4.5", "mine"]);
    }

    #[tokio::test]
    #[serial]
    async fn grok_table_keys_follow_the_provider_and_renames_replace_the_old_table() {
        let _home = Home::new();
        seed_grok(GROK_USER_LIVE);
        let state = state_with(
            AppType::GrokBuild,
            &[
                grok_row("a", "grok-4.5", "reasoning_summary = \"none\"\n"),
                grok_row("b", "b", ""),
            ],
            "b",
        )
        .await;

        ProviderService::switch(&state, AppType::GrokBuild, "a").expect("to a");
        assert_eq!(
            grok_doc()["model"]["grok-4.5"]["reasoning_summary"].as_str(),
            Some("none")
        );
        ProviderService::switch(&state, AppType::GrokBuild, "b").expect("to b");
        assert_eq!(grok_tables(), vec!["b", "mine"]);
        assert!(
            !grok_text().contains("reasoning_summary"),
            "{}",
            grok_text()
        );

        // 编辑当前供应商、把表名从 b 改成 grok-4.6：live 里只剩新表。
        let mut b = state
            .db
            .get_provider_by_id("b", "grokbuild")
            .unwrap()
            .unwrap();
        b.settings_config = grok_row("b", "grok-4.6", "").settings_config;
        ProviderService::update(&state, AppType::GrokBuild, Some("b"), b).expect("rename");
        assert_eq!(grok_tables(), vec!["grok-4.6", "mine"]);
        assert_eq!(grok_doc()["models"]["default"].as_str(), Some("grok-4.6"));
    }

    #[tokio::test]
    #[serial]
    async fn grok_without_a_write_record_infers_the_table_an_older_version_wrote() {
        let _home = Home::new();
        // 旧版把 a 的行整份写进了 live：新版没有写入记录。
        let a = grok_row("a", "grok-4.5", "");
        let old = format!(
            "{}\n{}",
            a.settings_config["config"].as_str().unwrap(),
            GROK_USER_LIVE
        );
        seed_grok(&old);
        let state = state_with(AppType::GrokBuild, &[a, grok_row("b", "b", "")], "a").await;

        ProviderService::switch(&state, AppType::GrokBuild, "b").expect("to b");
        assert_eq!(grok_tables(), vec!["b", "mine"], "{}", grok_text());
        assert_eq!(
            state::written(&DeviceStore::for_device(), "grokbuild")
                .unwrap()
                .unwrap()
                .tables,
            vec!["b".to_string()]
        );
    }

    #[tokio::test]
    #[serial]
    async fn grok_switch_crash_rolls_forward_with_the_write_record() {
        let _home = Home::new();
        seed_grok(GROK_USER_LIVE);
        let state = state_with(
            AppType::GrokBuild,
            &[grok_row("a", "grok-4.5", ""), grok_row("b", "b", "")],
            "a",
        )
        .await;
        ProviderService::switch(&state, AppType::GrokBuild, "a").expect("direct a");

        for point in ["published:0", "target"] {
            ProviderService::switch(&state, AppType::GrokBuild, "a").expect("reset");
            failpoint::crash_at(Some(point));
            let crashed = ProviderService::switch(&state, AppType::GrokBuild, "b");
            failpoint::crash_at(None);
            assert!(crashed.is_err(), "{point}");

            crate::mode::operation::recover_on_startup(&state.db);
            assert_eq!(grok_tables(), vec!["b", "mine"], "{point}");
            assert_eq!(direct(&state, &AppType::GrokBuild).as_deref(), Some("b"));
            assert_eq!(
                state::written(&DeviceStore::for_device(), "grokbuild")
                    .unwrap()
                    .unwrap()
                    .tables,
                vec!["b".to_string()],
                "{point}"
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn grok_editor_saves_the_table_to_the_row_and_global_edits_to_live() {
        let _home = Home::new();
        seed_grok(GROK_USER_LIVE);
        let state = state_with(
            AppType::GrokBuild,
            &[grok_row("a", "grok-4.5", ""), grok_row("b", "b", "")],
            "a",
        )
        .await;
        ProviderService::switch(&state, AppType::GrokBuild, "a").expect("direct a");

        let a = state
            .db
            .get_provider_by_id("a", "grokbuild")
            .unwrap()
            .unwrap();
        let view =
            ProviderService::editor_view(&state, AppType::GrokBuild, &a.settings_config, None)
                .expect("view");
        let shown = view.settings["config"].as_str().unwrap().to_string();
        assert!(
            shown.contains("[model.mine]") && shown.contains("key-a"),
            "{shown}"
        );

        let edited = shown
            .replace("theme = \"dark\"", "theme = \"light\"")
            .replace("a-model", "a-model-2");
        let mut row = a.clone();
        row.settings_config = json!({ "config": edited });
        ProviderService::update_from_editor(
            &state,
            AppType::GrokBuild,
            Some("a"),
            row,
            Some(crate::services::provider::EditorSave {
                base: view.settings,
                draft: None,
                on_conflict: Default::default(),
            }),
        )
        .expect("save");

        let doc = grok_doc();
        assert_eq!(doc["ui"]["theme"].as_str(), Some("light"));
        assert_eq!(
            doc["model"]["grok-4.5"]["model"].as_str(),
            Some("a-model-2")
        );
        let saved = state
            .db
            .get_provider_by_id("a", "grokbuild")
            .unwrap()
            .unwrap();
        let row_text = saved.settings_config["config"].as_str().unwrap();
        assert!(row_text.contains("a-model-2"), "{row_text}");
        assert!(
            !row_text.contains("[ui]") && !row_text.contains("[model.mine]"),
            "{row_text}"
        );
    }

    // ---------- 新增对话框：和编辑器同一套规则 ----------

    async fn state_without_providers() -> AppState {
        let db = Arc::new(Database::memory().expect("memory db"));
        db.update_proxy_config(ProxyConfig {
            listen_port: 0,
            ..Default::default()
        })
        .await
        .expect("ephemeral port");
        AppState::new(db)
    }

    fn add_from_editor(
        state: &AppState,
        app: AppType,
        mut row: Provider,
        edited: Value,
        base: Value,
    ) -> Result<bool, AppError> {
        // 和新增对话框一样：`row` 是投影成 `base` 的草稿。
        let draft = std::mem::replace(&mut row.settings_config, edited);
        ProviderService::add_from_editor(
            state,
            app,
            row,
            true,
            Some(crate::services::provider::EditorSave {
                base,
                draft: Some(draft),
                on_conflict: Default::default(),
            }),
        )
    }

    #[tokio::test]
    #[serial]
    async fn codex_add_dialog_saves_key_fields_to_the_row_and_global_edits_to_live() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(CODEX_USER_LIVE, None);
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;

        // 新增 c：显示的是切到 c 之后的 config.toml，全局部分来自 live。
        let draft = codex_row("c", "https://c.example/v1", "");
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &draft.settings_config, None)
                .expect("view c");
        let shown = view.settings["config"].as_str().unwrap().to_string();
        assert!(
            shown.contains("gpt-c") && shown.contains("approval_policy"),
            "{shown}"
        );
        let mut edited = view.settings.clone();
        edited["config"] = json!(shown.replace("\"on-request\"", "\"never\""));
        add_from_editor(&state, AppType::Codex, draft, edited, view.settings).expect("add c");

        let live = codex_text();
        assert!(live.contains("approval_policy = \"never\""), "{live}");
        assert_eq!(codex_doc()["model"].as_str(), Some("gpt-a"), "{live}");
        let c = state.db.get_provider_by_id("c", "codex").unwrap().unwrap();
        let c_config = c.settings_config["config"].as_str().unwrap();
        assert!(
            c_config.contains("gpt-c") && !c_config.contains("approval_policy"),
            "{c_config}"
        );
        assert_eq!(
            c.meta.as_ref().and_then(|meta| meta.common_config_enabled),
            Some(true)
        );
    }

    /// 新增对话框的底已经套了预设：预设带的独有字段归新供应商，live 里用户自己写的不归它。
    #[tokio::test]
    #[serial]
    async fn codex_add_dialog_keeps_the_users_exclusive_fields_out_of_the_new_row() {
        let _home = Home::new();
        set_preservation(true);
        seed_codex(
            &CODEX_USER_LIVE.replace(
                "model = \"gpt-a\"\n",
                "model = \"gpt-a\"\nmodel_verbosity = \"high\"\n",
            ),
            None,
        );
        let state = state_with(AppType::Codex, &codex_a_b(), "a").await;

        let draft = codex_row(
            "c",
            "https://c.example/v1",
            "model_auto_compact_token_limit = 90000\n",
        );
        let view =
            ProviderService::editor_view(&state, AppType::Codex, &draft.settings_config, None)
                .expect("view c");
        let shown = view.settings["config"].as_str().unwrap();
        assert!(
            shown.contains("model_verbosity") && shown.contains("model_auto_compact_token_limit"),
            "{shown}"
        );
        add_from_editor(
            &state,
            AppType::Codex,
            draft,
            view.settings.clone(),
            view.settings,
        )
        .expect("add c");

        let c = state.db.get_provider_by_id("c", "codex").unwrap().unwrap();
        let c_config = c.settings_config["config"].as_str().unwrap();
        assert!(
            c_config.contains("model_auto_compact_token_limit = 90000")
                && !c_config.contains("model_verbosity"),
            "{c_config}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn gemini_add_dialog_first_provider_writes_key_fields_and_sets_the_pointer() {
        let _home = Home::new();
        seed_gemini(GEMINI_USER_ENV, GEMINI_USER_SETTINGS);
        let state = state_without_providers().await;

        let draft = Provider::with_id(
            "c".to_string(),
            "C".to_string(),
            json!({ "env": {
                "GEMINI_API_KEY": "key-c",
                "GOOGLE_GEMINI_BASE_URL": "https://c.example",
                "GEMINI_MODEL": "m-c",
            }, "config": {} }),
            None,
        );
        let view =
            ProviderService::editor_view(&state, AppType::Gemini, &draft.settings_config, None)
                .expect("view c");
        assert_eq!(view.settings["env"]["GEMINI_SANDBOX"], json!("docker"));
        let mut edited = view.settings.clone();
        edited["env"]["DEBUG"] = json!("5");
        edited["config"]["ui"] = json!({ "theme": "dark" });
        add_from_editor(&state, AppType::Gemini, draft, edited, view.settings).expect("add c");

        let env = gemini_env();
        assert!(
            env.contains("GEMINI_API_KEY=key-c")
                && env.contains("GEMINI_MODEL=m-c")
                && env.contains("DEBUG=5")
                && env.contains("# my notes"),
            "{env}"
        );
        assert_eq!(gemini_settings()["ui"], json!({ "theme": "dark" }));
        assert_eq!(
            crate::mode::current::provider_for(
                &state.db,
                &AppType::Gemini,
                crate::mode::current::Purpose::Direct
            )
            .unwrap()
            .as_deref(),
            Some("c")
        );
        let c = state.db.get_provider_by_id("c", "gemini").unwrap().unwrap();
        assert!(c.settings_config["env"].get("DEBUG").is_none());
        assert!(c.settings_config["config"].get("ui").is_none());
    }

    #[tokio::test]
    #[serial]
    async fn grok_add_dialog_first_provider_records_the_written_table() {
        let _home = Home::new();
        seed_grok(GROK_USER_LIVE);
        let state = state_without_providers().await;

        let draft = grok_row("a", "grok-4.5", "");
        let view =
            ProviderService::editor_view(&state, AppType::GrokBuild, &draft.settings_config, None)
                .expect("view a");
        let shown = view.settings["config"].as_str().unwrap().to_string();
        assert!(
            shown.contains("[model.mine]") && shown.contains("key-a"),
            "{shown}"
        );
        let edited = json!({ "config": shown.replace("theme = \"dark\"", "theme = \"light\"") });
        add_from_editor(&state, AppType::GrokBuild, draft, edited, view.settings).expect("add a");

        let doc = grok_doc();
        assert_eq!(doc["ui"]["theme"].as_str(), Some("light"));
        assert_eq!(doc["models"]["default"].as_str(), Some("grok-4.5"));
        assert_eq!(grok_tables(), vec!["grok-4.5", "mine"]);
        let written = crate::mode::state::written(&DeviceStore::for_device(), "grokbuild")
            .unwrap()
            .expect("write record");
        assert_eq!(written.tables, vec!["grok-4.5".to_string()]);
        let a = state
            .db
            .get_provider_by_id("a", "grokbuild")
            .unwrap()
            .unwrap();
        let row_text = a.settings_config["config"].as_str().unwrap();
        assert!(
            !row_text.contains("[ui]") && !row_text.contains("[model.mine]"),
            "{row_text}"
        );

        // 第二个新增的供应商不动 live 的关键字段。
        let draft = grok_row("b", "b", "");
        let view =
            ProviderService::editor_view(&state, AppType::GrokBuild, &draft.settings_config, None)
                .expect("view b");
        let edited = view.settings.clone();
        add_from_editor(&state, AppType::GrokBuild, draft, edited, view.settings).expect("add b");
        assert_eq!(grok_doc()["models"]["default"].as_str(), Some("grok-4.5"));
        assert_eq!(grok_tables(), vec!["grok-4.5", "mine"]);
    }
}
