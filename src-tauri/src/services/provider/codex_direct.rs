//! 写 Codex 的客户端文件：`config.toml` 只替换关键字段和独有字段，其余字节不碰；
//! `auth.json`、模型目录、托管账号的登录标记、登录暂存和它在同一个操作里提交，崩溃后按
//! pending 前滚或丢弃。
//!
//! 写 Codex live 的入口（切换、新增第一个供应商、编辑当前供应商、同步、统一供应商、
//! 原生账号切换）都走这里。不回填、不合并通用配置片段、不补回 MCP：这些设置本来就
//! 留在 live 里。
//!
//! 分三步：
//! 1. [`prepare`]：拿写锁之前做要联网的事（取托管账号的 token、采纳 Codex CLI 轮换过的
//!    refresh token）；
//! 2. [`plan`]：在内存里算出 `config.toml` 的补丁和模型目录，行有问题就在这里
//!    报错，什么都不写；
//! 3. [`run`]：拿写锁，读 live 的 `auth.json` 决定它的去向（见 `codex_login`），再按
//!    盘上有没有登录定下路由表的 `requires_openai_auth`，一起提交。

use serde_json::{Map, Value};
use toml_edit::{Item, Value as TomlValue};

use crate::app_config::AppType;
use crate::auth::codex_oauth::CodexLiveAuthSwitchGuard;
use crate::auth::codex_oauth::CodexOAuthManager;
use crate::codex_config::{
    codex_auth_has_credential_login_material, codex_config_auth_store_mode,
    codex_disables_web_search, codex_live_auth_is_managed_chatgpt_login,
    codex_managed_oauth_marker_bytes, extract_codex_auth_api_key, get_codex_auth_path,
    get_codex_config_path, get_codex_managed_oauth_live_auth_marker_path,
    get_codex_model_catalog_path, plan_codex_model_catalog, CodexAuthStoreMode,
};
use crate::config::sorted_json_bytes;
use crate::database::Database;
use crate::error::AppError;
use crate::live::engine::{digest, read_current, DeviceStore, LiveFile};
use crate::live::patch::toml::{TomlDocPatch, TomlSteps};
use crate::live::patch::{Guarded, LivePatch, WholeFile};
use crate::live::project::codex::{
    requires_openai_auth, row_catalog_pointer, CodexConfigPatch, CodexProjection, KnownTable,
    Route, RouteAuth, RouteWrite, RowInput, WEB_SEARCH_DISABLED,
};
use crate::mode::operation::{AppWrite, FileChange, OperationReport};
use crate::mode::state::{Contract, PendingTarget};
use crate::provider::Provider;
use std::sync::Arc;

use super::codex_login::{self, AuthInput, AuthTarget, LoginStash, STASH_FILENAME};
use super::ProviderService;

fn app() -> &'static str {
    AppType::Codex.as_str()
}

/// 官方卡：`category == "official"`，或按 `is_codex_official_provider` 认出来的（早期
/// 绑定托管账号时没存 category 的卡）。
pub(crate) fn is_official(provider: &Provider) -> bool {
    provider.category.as_deref() == Some("official")
        || crate::codex_config::is_codex_official_provider(provider)
}

fn managed_account(provider: &Provider) -> Option<String> {
    ProviderService::managed_codex_oauth_account_id(provider)
}

/// Reject configurations that depend on a removed local converter or token injector.
pub(crate) fn ensure_direct(provider: &Provider) -> Result<(), AppError> {
    super::codex_accounts::ensure_api_provider(provider)?;
    let fail = |detail: &str| {
        AppError::localized(
            "provider.codex.native_responses_required",
            format!("Codex 仅支持官方账号或原生 Responses 供应商：{detail}"),
            format!("Codex requires an official account or a native Responses provider: {detail}"),
        )
    };
    if provider.meta.as_ref().and_then(|meta| meta.is_full_url) == Some(true)
        || ["isFullUrl", "is_full_url", "fullURL", "fullUrl"]
            .iter()
            .any(|key| provider.settings_config.get(*key).and_then(Value::as_bool) == Some(true))
    {
        return Err(fail("full endpoint URL mode is unsupported"));
    }
    if provider.uses_proxy_injected_oauth() {
        return Err(fail("this OAuth provider requires local token injection"));
    }
    let formats = [
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref()),
        provider
            .settings_config
            .get("api_format")
            .and_then(Value::as_str),
        provider
            .settings_config
            .get("apiFormat")
            .and_then(Value::as_str),
    ];
    for format in formats.into_iter().flatten() {
        if !matches!(
            format.trim().to_ascii_lowercase().as_str(),
            "" | "responses" | "openai_responses" | "openai-responses"
        ) {
            return Err(fail(
                "Chat Completions and Anthropic formats require a converter",
            ));
        }
    }
    let text = provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or("");
    let doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|err| AppError::Config(format!("Invalid Codex config.toml: {err}")))?;
    let selector = doc.get("model_provider").and_then(Item::as_str);
    let table = selector.and_then(|id| doc.get("model_providers")?.get(id));
    let placeholder = crate::live::project::codex::PROXY_TOKEN_PLACEHOLDER;
    if provider
        .settings_config
        .pointer("/auth/OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| key.trim() == placeholder)
        || [
            doc.get("experimental_bearer_token"),
            table.and_then(|table| table.get("experimental_bearer_token")),
        ]
        .into_iter()
        .flatten()
        .any(|token| {
            token
                .as_str()
                .is_some_and(|token| token.trim() == placeholder)
        })
    {
        return Err(fail(
            "legacy local routing placeholder cannot be used as a native credential",
        ));
    }
    for wire in [
        doc.get("wire_api"),
        table.and_then(|table| table.get("wire_api")),
    ]
    .into_iter()
    .flatten()
    {
        if wire
            .as_str()
            .is_none_or(|wire| !wire.trim().eq_ignore_ascii_case("responses"))
        {
            return Err(fail("selected wire_api must be responses"));
        }
    }
    for url in [
        doc.get("openai_base_url").and_then(Item::as_str),
        table
            .and_then(|table| table.get("base_url"))
            .and_then(Item::as_str),
        provider
            .settings_config
            .get("base_url")
            .and_then(Value::as_str),
        provider
            .settings_config
            .get("baseURL")
            .and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    {
        if url
            .trim_end_matches('/')
            .to_ascii_lowercase()
            .ends_with("/chat/completions")
        {
            return Err(fail(
                "Chat Completions endpoints cannot serve native Responses",
            ));
        }
    }
    Ok(())
}

/// 写成什么样。
#[derive(Clone, Copy)]
pub(crate) enum Target<'a> {
    /// 直连：这个供应商（`None`：没有直连供应商，只清掉关键字段）。
    Direct(Option<&'a Provider>),
    Account(&'a str),
}

/// live 现在是谁写进去的：删它带进来的独有字段、认出要切走的托管账号、判断用户是不是
/// 登出了，都看它。
#[derive(Clone, Copy)]
pub(crate) enum Owner<'a> {
    Provider(&'a Provider),
    Account(&'a str),
    /// 代理契约，`route` 是契约对应的路由供应商（找得到时）。
    Contract {
        contract: &'a Contract,
        route: Option<&'a Provider>,
    },
    None,
}

impl<'a> Owner<'a> {
    fn provider(&self) -> Option<&'a Provider> {
        match self {
            Self::Provider(provider) => Some(provider),
            Self::Contract { route, .. } => *route,
            Self::None | Self::Account(_) => None,
        }
    }
}

/// 拿写锁之前准备好的托管账号凭据。
#[derive(Default)]
pub(crate) struct Prepared {
    /// 目标托管账号和它的登录。
    target_login: Option<(String, Value)>,
    /// 要切走的托管账号，和采纳 CLI 轮换后记下的盘上 refresh token。
    outgoing: Option<(String, CodexLiveAuthSwitchGuard)>,
}

fn target_provider<'a>(target: &Target<'a>) -> Option<&'a Provider> {
    match target {
        Target::Direct(provider) => *provider,
        Target::Account(_) => None,
    }
}

fn target_account(target: &Target<'_>) -> Option<String> {
    if let Target::Account(id) = target {
        return Some((*id).to_string());
    }
    target_provider(target)
        .filter(|provider| is_official(provider))
        .and_then(managed_account)
}

/// 取目标托管账号的登录（必要时刷新 token），并在切走托管账号前采纳 Codex CLI 轮换过的
/// refresh token。都可能联网，所以在拿写锁之前做。
pub(crate) fn prepare(
    manager: &Arc<CodexOAuthManager>,
    owner: &Owner<'_>,
    target: &Target<'_>,
) -> Result<Prepared, AppError> {
    if let Some(provider) = target_provider(target) {
        ensure_direct(provider)?;
    }
    let target_account = target_account(target);
    let target_login = match &target_account {
        Some(account) => Some((
            account.clone(),
            super::live::get_codex_managed_oauth_live_auth_value(manager.clone(), account.clone())?,
        )),
        None => None,
    };
    let owned_account = match owner {
        Owner::Account(id) => Some((*id).to_string()),
        _ => owner.provider().and_then(managed_account),
    };
    let outgoing = match owned_account.filter(|account| target_account.as_ref() != Some(account)) {
        Some(account) => {
            let guard = super::live::prepare_codex_managed_oauth_live_auth_switch_away(
                manager.clone(),
                account.clone(),
            )?;
            Some((account, guard))
        }
        None => None,
    };
    Ok(Prepared {
        target_login,
        outgoing,
    })
}

fn project(provider: &Provider) -> Result<CodexProjection, AppError> {
    CodexProjection::of(&RowInput {
        settings: &provider.settings_config,
        official: is_official(provider),
        proxy_injected_oauth: provider.uses_proxy_injected_oauth(),
    })
}

/// 这个供应商的独有字段，含 `web_search`（需要时为 `"disabled"`）。
fn exclusive_of(provider: &Provider, projection: &CodexProjection) -> Vec<(String, TomlValue)> {
    let mut exclusive = projection.exclusive.clone();
    let profile = crate::codex_config::resolve_catalog_tool_profile(provider);
    if codex_disables_web_search(
        &provider.settings_config,
        &projection.catalog_input_text(),
        profile,
    ) {
        exclusive.retain(|(key, _)| key != "web_search");
        exclusive.push((
            "web_search".to_string(),
            TomlValue::from(WEB_SEARCH_DISABLED),
        ));
    }
    exclusive
}

/// live 现在对应的那一家带进来的独有字段和行里指定的模型目录指针：切走时值还相同就删。
pub(crate) fn outgoing_exclusive(owner: &Owner<'_>) -> Vec<(String, TomlValue)> {
    match owner {
        Owner::Provider(provider) => match project(provider) {
            Ok(projection) => {
                let mut fields = exclusive_of(provider, &projection);
                fields.extend(row_catalog_pointer(&projection.top).cloned());
                fields
            }
            Err(err) => {
                log::warn!(
                    "无法投影 Codex 供应商 {} 的独有字段，切走时不清理它们: {err}",
                    provider.id
                );
                Vec::new()
            }
        },
        Owner::Contract { contract, .. } => contract
            .exclusive
            .iter()
            .filter_map(|(key, value)| {
                let literal = value.as_str()?.parse::<TomlValue>().ok()?;
                Some((key.clone(), literal))
            })
            .collect(),
        Owner::None | Owner::Account(_) => Vec::new(),
    }
}

/// 数据库里所有 Codex 行能证明的事：它们的投影写过哪些表、第三方的 Key、官方卡里存着的
/// 登录（登录暂存第一次建立时用）。
struct RowFacts {
    retired: Vec<KnownTable>,
    third_party_keys: Vec<String>,
    official_logins: Vec<Value>,
}

fn row_facts(db: &Database) -> Result<RowFacts, AppError> {
    let mut facts = RowFacts {
        retired: Vec::new(),
        third_party_keys: Vec::new(),
        official_logins: Vec::new(),
    };
    for provider in db.get_all_providers(app())?.values() {
        let auth = provider.settings_config.get("auth");
        // OpenAI API keys are provider-owned credentials too.
        if let Some(key) = auth.and_then(extract_codex_auth_api_key) {
            facts.third_party_keys.push(key);
        }
        if is_official(provider) {
            if managed_account(provider).is_none() {
                if let Some(auth) =
                    auth.filter(|auth| codex_auth_has_credential_login_material(auth))
                {
                    facts.official_logins.push(auth.clone());
                }
            }
            continue;
        }
        if let Some(key) = auth.and_then(extract_codex_auth_api_key) {
            facts.third_party_keys.push(key);
        }
        let Some(doc) = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
        else {
            continue;
        };
        let providers = doc.get("model_providers").and_then(Item::as_table_like);
        let base_url_of = |id: &str| {
            providers
                .and_then(|table| table.get(id))
                .and_then(Item::as_table_like)
                .and_then(|table| table.get("base_url"))
                .and_then(Item::as_str)
                .map(|url| url.trim().to_string())
        };
        // 旧版整份写入时，provider 表用的是行自己的 id；保留当前存储的 id 与地址作为证据。
        let selector = doc
            .get("model_provider")
            .and_then(Item::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some((id, base_url)) = selector.and_then(|id| Some((id, base_url_of(id)?))) {
            facts.retired.push(KnownTable {
                id: id.to_string(),
                base_url,
            });
        }
        if let Some(base_url) = doc
            .get("openai_base_url")
            .and_then(Item::as_str)
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
        {
            // Only the historical generated id is owned here, and only when its
            // live upstream URL equals this stored row's old top-level route.
            // The current codex-switch prefix preserves unknown user tables.
            facts.retired.push(KnownTable {
                id: "cc-switch".to_string(),
                base_url,
            });
        }
    }
    Ok(facts)
}

/// `auth.json` 的去向（拥有所有权的版本，[`run`] 里转成 `codex_login::AuthTarget`）。
#[derive(Debug, Clone)]
enum AuthGoal {
    ThirdParty,
    /// 没有直连供应商：不动原生登录，只清托管账号的登录。
    KeepNative,
    Official(Value),
    Managed(Value),
}

/// 行里的 `auth`（没有时是空对象）。
fn row_auth(provider: &Provider) -> Value {
    provider
        .settings_config
        .get("auth")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// 在内存里算好的一次 Codex 写入。
pub(crate) struct Planned {
    config: CodexConfigPatch,
    /// 第三方路由表的凭据来源：写入时按盘上有没有登录定 `requires_openai_auth`。
    stamp: Option<RouteAuth>,
    catalog: Option<Vec<u8>>,
    auth: AuthGoal,
    /// 切走的是没绑托管账号的官方卡：它行里的 `auth`。
    leaving_official: Option<Value>,
    retired_keys: Vec<String>,
    official_logins: Vec<Value>,
    cleanup_key: Option<String>,
}

impl Planned {
    /// `config.toml` 的补丁（编辑器显示用：在内存里对 live 做一次切换投影）。
    pub(crate) fn config(&self) -> &CodexConfigPatch {
        &self.config
    }
}

/// 算出写入内容；行有问题（比如会把官方登录发给第三方）就在这里报错，什么都不写。
pub(crate) fn plan(
    db: &Database,
    owner: &Owner<'_>,
    target: &Target<'_>,
    prepared: &Prepared,
) -> Result<Planned, AppError> {
    let provider = target_provider(target);
    if let Some(provider) = provider {
        ensure_direct(provider)?;
    }
    let mut facts = row_facts(db)?;
    // Earlier native projections normalized the outgoing row's selected table to `custom`.
    // Its recorded upstream proves ownership even when the row still uses its original id.
    if let Some(outgoing) = owner.provider() {
        if let Ok(CodexProjection {
            route: Route::Custom { table, .. },
            ..
        }) = project(outgoing)
        {
            if let Some(base_url) = table.get("base_url").and_then(Item::as_str) {
                facts.retired.push(KnownTable {
                    id: crate::live::project::codex::ROUTE_ID.to_string(),
                    base_url: base_url.trim().to_string(),
                });
            }
        }
    }
    let projection = provider.map(project).transpose()?;

    let (top, nested, exclusive) = match (&projection, provider) {
        (Some(projection), Some(provider)) => (
            projection.top.clone(),
            projection.nested.clone(),
            exclusive_of(provider, projection),
        ),
        _ => (Vec::new(), Vec::new(), Vec::new()),
    };

    let official = provider.is_some_and(is_official);
    let managed_login = prepared.target_login.as_ref().map(|(_, auth)| auth.clone());
    let (route, stamp, auth) = match (target, &projection) {
        (Target::Account(_), _) => (
            if crate::settings::unify_codex_session_history() {
                RouteWrite::OfficialMirror
            } else {
                RouteWrite::Official
            },
            None,
            managed_login
                .map(AuthGoal::Managed)
                .unwrap_or(AuthGoal::KeepNative),
        ),
        (Target::Direct(None), _) | (_, None) => (RouteWrite::Default, None, AuthGoal::KeepNative),
        (Target::Direct(Some(provider)), Some(projection)) => {
            let auth = match &managed_login {
                Some(login) => AuthGoal::Managed(login.clone()),
                None if official => AuthGoal::Official(row_auth(provider)),
                None => AuthGoal::ThirdParty,
            };
            match &projection.route {
                Route::Official if crate::settings::unify_codex_session_history() => {
                    (RouteWrite::OfficialMirror, None, auth)
                }
                Route::Official => (RouteWrite::Official, None, auth),
                Route::Custom { table, auth: kind } => {
                    (RouteWrite::Custom(table.clone()), Some(*kind), auth)
                }
                Route::BuiltIn { id, table } => (
                    RouteWrite::BuiltIn {
                        id: id.clone(),
                        table: table.clone(),
                    },
                    None,
                    auth,
                ),
                Route::Default => (RouteWrite::Default, None, auth),
            }
        }
    };

    let catalog_plan = match (provider, &projection) {
        (Some(provider), Some(projection)) => Some(plan_codex_model_catalog(
            &provider.settings_config,
            &projection.catalog_input_text(),
            crate::codex_config::resolve_catalog_tool_profile(provider),
        )?),
        _ => None,
    };
    let catalog = catalog_plan
        .and_then(|plan| plan.catalog)
        .map(|catalog| sorted_json_bytes(&catalog))
        .transpose()?;

    let leaving_official = owner
        .provider()
        .filter(|provider| is_official(provider) && managed_account(provider).is_none())
        .map(row_auth);

    let config = CodexConfigPatch {
        top,
        nested,
        exclusive,
        outgoing: outgoing_exclusive(owner),
        route,
        catalog: catalog.is_some(),
        retired: facts.retired,
    };
    Ok(Planned {
        config,
        stamp,
        catalog,
        auth,
        leaving_official,
        retired_keys: if matches!(target, Target::Direct(None)) {
            owner
                .provider()
                .and_then(|provider| provider.settings_config.get("auth"))
                .and_then(extract_codex_auth_api_key)
                .into_iter()
                .collect()
        } else {
            facts.third_party_keys
        },
        official_logins: facts.official_logins,
        cleanup_key: if matches!(target, Target::Direct(None)) {
            owner
                .provider()
                .and_then(|provider| provider.settings_config.get("auth"))
                .and_then(extract_codex_auth_api_key)
        } else {
            None
        },
    })
}

/// 读登录暂存。
struct LoadedStash {
    stash: LoginStash,
    pre: Option<Vec<u8>>,
    /// 文件在但解析不了（截断、半截拷贝）：里面可能还有登录，不能覆盖。按空的用，这次
    /// 要往里存登录就停下。
    unreadable: Option<String>,
}

fn load_stash(store: &DeviceStore, official_logins: &[Value]) -> LoadedStash {
    let path = store.file(STASH_FILENAME);
    let pre = read_current(&path).ok().flatten();
    let (stash, unreadable) = match pre.as_deref().map(serde_json::from_slice::<LoginStash>) {
        Some(Ok(stash)) => (
            LoginStash {
                initialized: true,
                ..stash
            },
            None,
        ),
        Some(Err(err)) => {
            log::warn!("Codex 登录暂存 {} 无法解析: {err}", path.display());
            (
                LoginStash {
                    initialized: true,
                    ..LoginStash::default()
                },
                Some(err.to_string()),
            )
        }
        None => (LoginStash::seeded_from_rows(official_logins), None),
    };
    LoadedStash {
        stash,
        pre,
        unreadable,
    }
}

fn guarded(pre: Option<&[u8]>, then: WholeFile) -> Guarded {
    Guarded {
        expected_pre: digest(pre),
        then,
    }
}

/// 执行一次 Codex 写入：拿写锁，决定 `auth.json` 的去向，和 `config.toml`、模型目录、
/// 托管账号标记、登录暂存一起提交，最后落定 `pending`（指针、模式状态）。
pub(crate) fn run(
    db: &Database,
    op: &str,
    planned: Planned,
    prepared: &Prepared,
    pending: PendingTarget,
) -> Result<OperationReport, AppError> {
    run_with_edits(db, op, planned, prepared, pending, None)
}

/// 同 [`run`]，另把编辑器里对全局设置的改动在同一次 `config.toml` 写入里应用。
pub(crate) fn run_with_edits(
    db: &Database,
    op: &str,
    planned: Planned,
    prepared: &Prepared,
    pending: PendingTarget,
    edits: Option<&super::editor_toml::TomlEdits>,
) -> Result<OperationReport, AppError> {
    // 先补完上一次的操作，再读 auth.json 和登录暂存：补完会改写它们，按补完前读到的内容
    // 写下去会被当成外部修改；`owner` 也是调用方按补完前的指针定的。
    let write = AppWrite::begin(db, app())?;
    let store = &write.store;

    // 切走的托管账号：采纳之后 CLI 又刷新了就停下，免得删掉新 token。
    if let Some((account, outgoing)) = &prepared.outgoing {
        outgoing.ensure_unchanged(account)?;
    }

    // auth.json 读不了（比如被换成了目录）：不碰它，其余照常写。
    let auth_path = get_codex_auth_path();
    let (auth_pre, auth_readable) = match read_current(&auth_path) {
        Ok(pre) => (pre, true),
        Err(err) => {
            log::warn!("读取 Codex auth.json 失败，这次不改动它: {err}");
            (None, false)
        }
    };
    let live_auth = auth_pre
        .as_deref()
        .map(|bytes| serde_json::from_slice::<Value>(bytes).unwrap_or(Value::Null));
    // 已被删除的托管账号放弃了所有权：它留在盘上的登录按用户自己的登录处理。
    let managed_accounts: Vec<&str> = prepared
        .outgoing
        .iter()
        .filter(|(_, guard)| !matches!(guard, CodexLiveAuthSwitchGuard::MissingAccount))
        .map(|(account, _)| account.as_str())
        .chain(
            prepared
                .target_login
                .iter()
                .map(|(account, _)| account.as_str()),
        )
        .collect();
    let live_is_managed = live_auth.as_ref().is_some_and(|auth| {
        managed_accounts
            .iter()
            .any(|account| codex_live_auth_is_managed_chatgpt_login(auth, account))
    });
    let outgoing_missing = prepared
        .outgoing
        .as_ref()
        .is_some_and(|(_, guard)| matches!(guard, CodexLiveAuthSwitchGuard::MissingAccount));

    let LoadedStash {
        stash,
        pre: stash_pre,
        unreadable: stash_unreadable,
    } = load_stash(store, &planned.official_logins);
    let preserve = crate::settings::preserve_codex_official_auth_on_switch();
    let target = match &planned.auth {
        AuthGoal::ThirdParty => AuthTarget::ThirdParty { preserve },
        AuthGoal::KeepNative => AuthTarget::KeepNative,
        AuthGoal::Official(row_auth) => AuthTarget::Official { row_auth },
        AuthGoal::Managed(auth) => AuthTarget::Managed { auth },
    };
    let original_stash = stash.clone();
    let mut auth_plan = codex_login::plan(AuthInput {
        live: live_auth.as_ref(),
        live_is_managed,
        third_party_keys: &planned.retired_keys,
        leaving_official: planned.leaving_official.as_ref(),
        target,
        stash,
    });
    if let Some(key) = &planned.cleanup_key {
        let mut cleaned = auth_plan.stash.clone().unwrap_or(original_stash.clone());
        cleaned
            .logins
            .retain(|_, auth| extract_codex_auth_api_key(auth).as_ref() != Some(key));
        if cleaned
            .last
            .as_ref()
            .is_some_and(|id| !cleaned.logins.contains_key(id))
        {
            cleaned.last = None;
        }
        if cleaned != original_stash {
            auth_plan.stash = Some(cleaned);
        }
    }
    // 暂存坏了只当它是空的读；要往里存登录（`auth.json` 里的登录要被删掉或换掉）时照写
    // 会覆盖掉里面原有的登录，停下。
    if let (Some(err), Some(_)) = (&stash_unreadable, &auth_plan.stash) {
        let path = store.file(STASH_FILENAME);
        return Err(AppError::localized(
            "codex.login_stash_unreadable",
            format!(
                "Codex 登录暂存 {} 无法解析（{err}）。这次切换要把 auth.json 里的登录存进去，照写会覆盖暂存里原有的登录。请修复或移走这个文件后重试。本次没有写入任何文件",
                path.display()
            ),
            format!(
                "The Codex login stash {} cannot be parsed ({err}). This switch needs to save the login from auth.json into it, and writing it would overwrite the logins it already holds. Repair or move the file away and try again. Nothing was written",
                path.display()
            ),
        ));
    }

    // Codex 把登录存在哪由 `cli_auth_credentials_store` 决定：只存 auth.json 时看它；
    // 存在系统钥匙串（keyring、auto）或认不出时看不到登录，按保留登录开关处理；
    // ephemeral 从不落盘，当成没登录。
    let login = match codex_config_auth_store_mode(
        &read_current(&get_codex_config_path())
            .ok()
            .flatten()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default(),
    ) {
        CodexAuthStoreMode::File => auth_plan.login_on_disk,
        CodexAuthStoreMode::Ephemeral => false,
        CodexAuthStoreMode::Keyring | CodexAuthStoreMode::Auto | CodexAuthStoreMode::Unknown => {
            !matches!(planned.auth, AuthGoal::ThirdParty) || preserve
        }
    };
    let mut config = planned.config;
    if let (Some(kind), RouteWrite::Custom(table)) = (planned.stamp, &mut config.route) {
        if matches!(kind, RouteAuth::Bearer | RouteAuth::EnvKey) {
            table.insert(
                "requires_openai_auth",
                toml_edit::value(requires_openai_auth(kind, login)),
            );
        }
    }

    let auth_patch = auth_plan
        .auth
        .clone()
        .filter(|_| auth_readable)
        .map(|auth| {
            let then = match auth {
                Some(auth) => sorted_json_bytes(&auth).map(WholeFile::Write),
                None => Ok(WholeFile::Delete),
            };
            then.map(|then| guarded(auth_pre.as_deref(), then))
        });
    let auth_patch = auth_patch.transpose()?;

    let marker_path = get_codex_managed_oauth_live_auth_marker_path();
    let marker_pre = read_current(&marker_path)?;
    let marker_patch = match (&prepared.target_login, &auth_plan.auth) {
        (Some((account, login)), Some(Some(written))) if written == login => {
            codex_managed_oauth_marker_bytes(login, account)?
                .map(|bytes| guarded(marker_pre.as_deref(), WholeFile::Write(bytes)))
        }
        _ if marker_pre.is_some()
            && ((live_is_managed && auth_plan.auth == Some(None)) || outgoing_missing) =>
        {
            Some(guarded(marker_pre.as_deref(), WholeFile::Delete))
        }
        _ => None,
    };

    let stash_patch = auth_plan
        .stash
        .as_ref()
        .map(|stash| {
            serde_json::to_vec_pretty(stash)
                .map(|bytes| guarded(stash_pre.as_deref(), WholeFile::Write(bytes)))
                .map_err(|e| AppError::Message(format!("序列化 Codex 登录暂存失败: {e}")))
        })
        .transpose()?;
    let catalog_patch = planned.catalog.map(WholeFile::Write);
    // 先应用编辑器里的全局改动（有的话），再换关键字段。
    let mut config_steps: Vec<&dyn TomlDocPatch> = Vec::new();
    if let Some(edits) = edits {
        config_steps.push(edits);
    }
    config_steps.push(&config);
    let config_patch = TomlSteps(config_steps);

    let mut changes: Vec<FileChange<'_>> = Vec::new();
    // auth.json 放第一个：Codex CLI 恰好在这时刷新了登录，就在发布任何文件之前停下。
    if let Some(patch) = &auth_patch {
        changes.push(FileChange {
            file: LiveFile::private(&auth_path),
            patch: patch as &dyn LivePatch,
        });
    }
    changes.push(FileChange {
        file: LiveFile::private(get_codex_config_path()),
        patch: &config_patch,
    });
    if let Some(patch) = &catalog_patch {
        changes.push(FileChange {
            file: LiveFile::shared(get_codex_model_catalog_path()),
            patch,
        });
    }
    if let Some(patch) = &marker_patch {
        changes.push(FileChange {
            file: LiveFile::private(&marker_path),
            patch,
        });
    }
    if let Some(patch) = &stash_patch {
        changes.push(FileChange {
            file: LiveFile::private(store.file(STASH_FILENAME)),
            patch,
        });
    }

    write.run(op, &changes, pending)
}

/// 直连写入：`prepare` → `plan` → `run`。
pub(crate) fn write_direct(
    db: &Database,
    manager: &Arc<CodexOAuthManager>,
    op: &str,
    owner: Owner<'_>,
    target: Option<&Provider>,
    pending: PendingTarget,
) -> Result<OperationReport, AppError> {
    let selected = crate::mode::current::codex_active_selection(db)?;
    let owner = match selected.as_ref() {
        Some(crate::mode::current::CodexActiveSelection::Account { account_id }) => {
            Owner::Account(account_id)
        }
        _ => owner,
    };
    let target = Target::Direct(target);
    let prepared = prepare(manager, &owner, &target)?;
    let planned = plan(db, &owner, &target, &prepared)?;
    run(db, op, planned, &prepared, pending)
}

/// 只校验，不写：切换前用它挡住会被拒绝的目标（行有问题时指针不能先动）。
pub(crate) fn preflight(db: &Database, provider: &Provider) -> Result<(), AppError> {
    let target = Target::Direct(Some(provider));
    plan(db, &Owner::None, &target, &Prepared::default()).map(|_| ())
}

/// Account selection currently publishes file credentials only. Use the same
/// projection and patch as the real switch, preserving global settings rather
/// than inventing a merge of legacy common snippets or provider snapshots.
pub(crate) fn preflight_account_auth_store(
    db: &Database,
    owner: &Owner<'_>,
    target: &Target<'_>,
) -> Result<(), AppError> {
    fn require_file(text: &str, zh_source: &str, en_source: &str) -> Result<(), AppError> {
        let doc = text.parse::<toml_edit::DocumentMut>().map_err(|error| {
            AppError::Config(format!("Cannot inspect Codex credential store: {error}"))
        })?;
        let declaration = doc.get("cli_auth_credentials_store");
        if codex_config_auth_store_mode(text) == CodexAuthStoreMode::File
            && declaration.is_none_or(|value| value.as_str() == Some("file"))
        {
            return Ok(());
        }
        let mode = declaration
            .map(ToString::to_string)
            .unwrap_or_else(|| "unknown".into());
        Err(AppError::localized(
            "codex.account_switch_requires_file_auth_store",
            format!(
                "当前账号切换仅支持 file 凭据存储。{zh_source} 将 cli_auth_credentials_store 设置为 {mode}，Codex 可能不会读取新账号的 auth.json。请在高级设置中自行选择 file 后重试；本次未更改账号或配置。"
            ),
            format!(
                "Account switching currently supports only the file credential store. {en_source} declares cli_auth_credentials_store = {mode}, so Codex may not read the new account's auth.json. Choose file in advanced settings before retrying. No account or configuration was changed."
            ),
        ))
    }

    if let Some(provider) = target_provider(target) {
        let declared = provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .unwrap_or("");
        // A legacy row may declare a global choice the current switch patch
        // leaves in live. Reject that explicit incompatible intent as well.
        require_file(
            declared,
            "所选高级配置",
            "The selected advanced configuration",
        )?;
    }
    // Generic provider writes may leave unreadable native auth alone. An
    // explicit account selection must be able to publish its credentials before
    // it can claim that this account is current. JSON validation remains with
    // the existing credential preparation and writer policy.
    let auth_path = get_codex_auth_path();
    read_current(&auth_path).map_err(|error| AppError::localized(
        "codex.account_switch_auth_unreadable",
        format!("无法读取 Codex 登录凭据文件 {}：{error}。本次未切换账号；请修复文件访问后重试。", auth_path.display()),
        format!("Cannot read Codex credentials at {}: {error}. The account was not switched. Fix access to the credentials file before retrying.", auth_path.display()),
    ))?;
    let planned = plan(db, owner, target, &Prepared::default())?;
    let path = get_codex_config_path();
    let before = read_current(&path)?;
    let projected = planned
        .config
        .apply(&path, before.as_deref())
        .map_err(|error| AppError::Config(error.to_string()))?;
    let text = String::from_utf8(projected)
        .map_err(|error| AppError::Config(format!("Invalid Codex configuration text: {error}")))?;
    require_file(
        &text,
        "Codex 的有效配置",
        "The effective Codex configuration",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::json;
    use std::path::Path;

    const NATIVE: &str = r#"model_provider = "deepseek"
model = "deepseek-flash"
model_reasoning_effort = "high"
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true
request_timeout_ms = 60000
[model_providers.deepseek.http_headers]
X-Team = "science"
"#;

    fn native() -> Provider {
        let mut provider = Provider::with_id(
            "deepseek".into(),
            "DeepSeek".into(),
            json!({"auth": {"OPENAI_API_KEY": "sk-native"}, "config": NATIVE,
                   "modelCatalog": {"models": [{"model": "deepseek-flash"}]}}),
            None,
        );
        provider.meta = Some(ProviderMeta {
            api_format: Some("openai_responses".into()),
            ..Default::default()
        });
        provider
    }

    #[test]
    fn rejects_conversion_configs_before_oauth_prepare_or_planning() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Arc::new(CodexOAuthManager::new(temp.path().join("accounts")));
        for kind in ["openai_chat", "anthropic", "chat_completions"] {
            let mut provider = native();
            provider.meta.as_mut().unwrap().api_format = Some(kind.into());
            assert!(ensure_direct(&provider).is_err(), "{kind}");
            assert!(prepare(&manager, &Owner::None, &Target::Direct(Some(&provider))).is_err());
        }
        let mut provider = native();
        provider.settings_config["apiFormat"] = json!("openai_chat");
        assert!(
            ensure_direct(&provider).is_err(),
            "all declared format sources must agree"
        );
        provider
            .settings_config
            .as_object_mut()
            .unwrap()
            .remove("apiFormat");
        provider.settings_config["config"] =
            json!(NATIVE.replace("wire_api = \"responses\"", "wire_api = \"chat\""));
        assert!(
            ensure_direct(&provider).is_err(),
            "metadata cannot override unsupported selected wire_api"
        );
        provider.settings_config["config"] = json!(NATIVE);
        provider.settings_config["auth"]["OPENAI_API_KEY"] = json!("PROXY_MANAGED");
        assert!(
            ensure_direct(&provider).is_err(),
            "legacy local credentials cannot be published"
        );
        provider.settings_config["auth"]["OPENAI_API_KEY"] = json!("sk-native");
        provider.meta.as_mut().unwrap().is_full_url = Some(true);
        assert!(ensure_direct(&provider).is_err());
        provider.meta.as_mut().unwrap().is_full_url = None;
        provider.meta.as_mut().unwrap().provider_type = Some("github_copilot".into());
        assert!(ensure_direct(&provider).is_err());
        assert!(
            !temp.path().join("accounts").exists(),
            "rejected targets must not publish account state"
        );
    }

    #[test]
    fn deepseek_native_plan_preserves_auth_config_and_official_catalog() {
        let provider = native();
        ensure_direct(&provider).unwrap();
        let db = Database::memory().unwrap();
        let planned = plan(
            &db,
            &Owner::None,
            &Target::Direct(Some(&provider)),
            &Prepared::default(),
        )
        .unwrap();
        assert!(matches!(planned.auth, AuthGoal::ThirdParty));
        let RouteWrite::Custom(table) = &planned.config.route else {
            panic!("native custom table")
        };
        assert_eq!(table["base_url"].as_str(), Some("https://api.deepseek.com"));
        assert_eq!(table["wire_api"].as_str(), Some("responses"));
        assert_eq!(
            table["experimental_bearer_token"].as_str(),
            Some("sk-native")
        );
        assert_eq!(table["request_timeout_ms"].as_integer(), Some(60000));
        assert_eq!(table["http_headers"]["X-Team"].as_str(), Some("science"));
        let catalog: Value = serde_json::from_slice(planned.catalog.as_deref().unwrap()).unwrap();
        let model = &catalog["models"][0];
        assert_eq!(model["slug"], "deepseek-flash");
        assert!(
            model.get("apply_patch_tool_type").is_some(),
            "DeepSeek's native official tools survive"
        );
        assert_eq!(
            provider.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-native"
        );
        let mut live: toml_edit::DocumentMut = "approval_policy = 'never'\n[model_providers.mine]\nname = 'User'\nbase_url = 'https://mine.example/v1'\n[profiles.mine]\nmodel_provider = 'mine'\n".parse().unwrap();
        planned
            .config
            .apply_to(Path::new("config.toml"), &mut live)
            .unwrap();
        assert_eq!(live["model_provider"].as_str(), Some("custom"));
        assert_eq!(live["approval_policy"].as_str(), Some("never"));
        assert_eq!(
            live["profiles"]["mine"]["model_provider"].as_str(),
            Some("mine")
        );
        assert_eq!(
            live["model_providers"]["mine"]["base_url"].as_str(),
            Some("https://mine.example/v1")
        );
        assert!(!live.to_string().contains("PROXY_MANAGED"));
        assert!(!live.to_string().contains("127.0.0.1"));
    }
}
