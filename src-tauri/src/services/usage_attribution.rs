//! Switch-owned annotations. Native Codex configuration and logs are only read.
use crate::auth::codex_oauth::CodexOAuthManager;
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::live::project::codex::{CodexProjection, Route, RowInput};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use toml_edit::{DocumentMut, Item, Table};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageIdentity {
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionChoice {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub identity: UsageIdentity,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionSelector {
    pub request_ids: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
    pub provider_name: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub attribution: Option<String>,
    pub account_id: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttributionResult {
    pub action_id: i64,
    pub count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct StoredTag {
    identity: UsageIdentity,
    method: String,
    tagged_at: i64,
}

pub(crate) fn source_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
fn choice(identity: UsageIdentity) -> UsageAttributionChoice {
    // Subscription accounts and API connections are peers in a Source picker.
    // The synthetic API account slot is an internal identity, not a second name.
    let is_api = identity
        .account_id
        .as_deref()
        .is_some_and(|id| id.starts_with("api:"));
    let preferred = if is_api {
        [&identity.provider_name, &identity.account_name]
    } else {
        [&identity.account_name, &identity.provider_name]
    };
    let label = preferred
        .into_iter()
        .filter_map(|name| name.as_deref())
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or("未识别")
        .to_owned();
    // Opaque stable choice ID contains no credentials.
    let id =
        serde_json::to_string(&(&identity.account_id, &identity.provider_id)).unwrap_or_default();
    UsageAttributionChoice {
        id,
        label,
        identity,
    }
}
fn provider_identity(provider: &crate::provider::Provider) -> UsageIdentity {
    UsageIdentity {
        account_id: Some(format!("api:{}", provider.id)),
        account_name: Some(format!("{} API 凭据", provider.name)),
        provider_id: Some(provider.id.clone()),
        provider_name: Some(provider.name.clone()),
    }
}
pub async fn get_usage_attribution_choices(
    db: &Database,
    manager: &CodexOAuthManager,
) -> Result<Vec<UsageAttributionChoice>, AppError> {
    let providers = db.get_all_providers("codex")?;
    let official = providers.values().find(|p| {
        crate::codex_config::is_codex_official_provider(p)
            || p.category.as_deref() == Some("official")
    });
    let mut choices = Vec::new();
    for account in manager.list_accounts().await {
        let metadata = manager.account_metadata(&account.id).await;
        choices.push(choice(UsageIdentity {
            account_id: Some(account.id),
            account_name: Some(metadata.display_name.unwrap_or(account.login)),
            provider_id: Some(
                official
                    .map(|p| p.id.clone())
                    .unwrap_or_else(|| "openai".into()),
            ),
            provider_name: Some(
                official
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| "OpenAI".into()),
            ),
        }));
    }
    for provider in providers.values() {
        if crate::codex_config::is_codex_official_provider(provider)
            || provider.category.as_deref() == Some("official")
        {
            continue;
        }
        choices.push(choice(provider_identity(provider)));
    }
    if let Ok(bytes) = std::fs::read(crate::codex_config::get_codex_auth_path()) {
        if let Ok(auth) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let mut managed = false;
            for candidate in &choices {
                if let Some(id) = candidate.identity.account_id.as_deref() {
                    if recorded_account_matches(&auth, id)
                        || account_matches_native(manager, &auth, id).await
                    {
                        managed = true;
                        break;
                    }
                }
            }
            if !managed {
                if let Some(mut identity) = native_account_identity(&auth) {
                    if let Some(provider) = official {
                        identity.provider_id = Some(provider.id.clone());
                        identity.provider_name = Some(provider.name.clone());
                    }
                    choices.push(choice(identity));
                }
            }
        }
    }
    let historical = {
        let conn = lock_conn!(db.conn);
        let mut stmt = conn.prepare("SELECT DISTINCT account_id,account_name,provider_id,provider_name FROM usage_record_attributions")?;
        let rows = stmt.query_map([], |row| {
            Ok(UsageIdentity {
                account_id: row.get(0)?,
                account_name: row.get(1)?,
                provider_id: row.get(2)?,
                provider_name: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for identity in historical {
        let candidate = choice(identity);
        if !choices.iter().any(|c| c.id == candidate.id) {
            choices.push(candidate);
        }
    }
    Ok(choices)
}

async fn account_matches_native(
    manager: &CodexOAuthManager,
    auth: &serde_json::Value,
    id: &str,
) -> bool {
    if id.starts_with("api:") || id.starts_with("native:") {
        return false;
    }
    let Some(user) = crate::codex_config::extract_codex_auth_user_identity(auth) else {
        return false;
    };
    let Some(workspace) = auth
        .pointer("/tokens/account_id")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    manager.account_user_identity(id).await.as_deref() == Some(user.as_str())
        && manager
            .chatgpt_account_id_for_account(id)
            .await
            .ok()
            .as_deref()
            == Some(workspace)
}

fn recorded_account_matches(auth: &serde_json::Value, id: &str) -> bool {
    !id.starts_with("api:")
        && !id.starts_with("native:")
        && crate::codex_config::get_codex_managed_oauth_live_auth_marker_path().exists()
        && crate::codex_config::codex_auth_matches_recorded_managed_oauth(auth, id).unwrap_or(false)
}

fn native_account_identity(auth: &serde_json::Value) -> Option<UsageIdentity> {
    if auth
        .get("auth_mode")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|m| m != "chatgpt")
        || auth
            .get("OPENAI_API_KEY")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|v| !v.trim().is_empty())
    {
        return None;
    }
    let user = crate::codex_config::extract_codex_auth_user_identity(auth)?;
    let workspace = auth.pointer("/tokens/account_id")?.as_str()?.trim();
    if workspace.is_empty() {
        return None;
    }
    Some(UsageIdentity {
        account_id: Some(format!("native:{user}:{workspace}")),
        account_name: Some(format!(
            "Codex 登录账户 ({})",
            workspace.chars().take(8).collect::<String>()
        )),
        provider_id: Some("openai".into()),
        provider_name: Some("OpenAI".into()),
    })
}

fn table_signature(table: &Table) -> Option<String> {
    // Only endpoint + effective credential mechanism identify an API connection.
    // This signature is compared in memory, never persisted or logged.
    let endpoint = table
        .get("base_url")?
        .as_str()?
        .trim()
        .trim_end_matches('/');
    if endpoint.is_empty() {
        return None;
    }
    let bearer = table
        .get("experimental_bearer_token")
        .and_then(Item::as_str)
        .filter(|v| !v.trim().is_empty());
    let env = table
        .get("env_key")
        .and_then(Item::as_str)
        .filter(|v| !v.trim().is_empty());
    let headers = table.get("http_headers").map(ToString::to_string);
    let env_headers = table.get("env_http_headers").map(ToString::to_string);
    if bearer.is_none() && env.is_none() && headers.is_none() && env_headers.is_none() {
        return None;
    }
    Some(format!(
        "{endpoint}|{bearer:?}|{env:?}|{headers:?}|{env_headers:?}"
    ))
}
/// Resolve actual on-disk selection. No refresh, fallback-default account, or native write.
pub async fn read_current_identity(
    db: &Database,
    manager: &CodexOAuthManager,
) -> Result<Option<UsageIdentity>, AppError> {
    let source = source_key(&crate::codex_usage_source::get_codex_usage_source_dir());
    let config_path = crate::codex_config::get_codex_config_path();
    let auth_path = crate::codex_config::get_codex_auth_path();
    let config = std::fs::read(&config_path).ok();
    let auth = std::fs::read(&auth_path).ok();
    let identity = resolve_current_identity(db, manager).await?;
    // Awaiting manager snapshots can overlap a switch. An inconsistent snapshot
    // leaves this observation unknown rather than combining two identities.
    if source != source_key(&crate::codex_usage_source::get_codex_usage_source_dir())
        || config_path != crate::codex_config::get_codex_config_path()
        || auth_path != crate::codex_config::get_codex_auth_path()
        || config != std::fs::read(&config_path).ok()
        || auth != std::fs::read(&auth_path).ok()
    {
        return Ok(None);
    }
    Ok(identity)
}

async fn resolve_current_identity(
    db: &Database,
    manager: &CodexOAuthManager,
) -> Result<Option<UsageIdentity>, AppError> {
    use crate::codex_config::*;
    let source = crate::codex_usage_source::get_codex_usage_source_dir();
    if source_key(&source) != source_key(&get_codex_config_dir()) {
        return Ok(None);
    }
    let Ok(text) = std::fs::read_to_string(get_codex_config_path()) else {
        return Ok(None);
    };
    let Ok(doc) = text.parse::<DocumentMut>() else {
        return Ok(None);
    };
    // Profile overlays may replace native routing. Missing or malformed selections
    // cannot prove an active identity and must never fall back to an official account.
    let profile_name = doc.get("profile").map(Item::as_str);
    if matches!(profile_name, Some(None)) {
        return Ok(None);
    }
    let profile = profile_name
        .flatten()
        .and_then(|id| doc.get("profiles")?.get(id));
    if profile_name.is_some() && profile.is_none() {
        return Ok(None);
    }
    let selected_value = profile
        .and_then(|p| p.get("model_provider"))
        .or_else(|| doc.get("model_provider"));
    if selected_value.is_some_and(|v| v.as_str().is_none()) {
        return Ok(None);
    }
    let selected = selected_value.and_then(Item::as_str).unwrap_or("openai");
    let table = doc
        .get("model_providers")
        .and_then(|p| p.get(selected))
        .and_then(Item::as_table);
    let official = selected == "openai"
        && doc
            .get("model_providers")
            .and_then(|p| p.get(selected))
            .is_none()
        && doc.get("openai_base_url").is_none()
        && profile.and_then(|p| p.get("openai_base_url")).is_none()
        || table
            .and_then(|t| t.get("base_url"))
            .and_then(Item::as_str)
            .is_some_and(|url| {
                url.trim_end_matches('/') == "https://chatgpt.com/backend-api/codex"
            })
            && table
                .and_then(|t| t.get("experimental_bearer_token"))
                .is_none()
            && table.and_then(|t| t.get("env_key")).is_none()
            && table.and_then(|t| t.get("http_headers")).is_none()
            && table.and_then(|t| t.get("env_http_headers")).is_none();
    let providers = db.get_all_providers("codex")?;
    let official_provider = providers.values().find(|p| {
        crate::codex_config::is_codex_official_provider(p)
            || p.category.as_deref() == Some("official")
    });
    if official {
        let Ok(bytes) = std::fs::read(get_codex_auth_path()) else {
            return Ok(None);
        };
        let Ok(auth) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return Ok(None);
        };
        if auth
            .get("auth_mode")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|m| m != "chatgpt")
            || auth
                .get("OPENAI_API_KEY")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|v| !v.trim().is_empty())
        {
            return Ok(None);
        }
        let mut matches = Vec::new();
        for account in manager.list_accounts().await {
            if recorded_account_matches(&auth, &account.id)
                || account_matches_native(manager, &auth, &account.id).await
            {
                let metadata = manager.account_metadata(&account.id).await;
                matches.push(UsageIdentity {
                    account_id: Some(account.id),
                    account_name: Some(metadata.display_name.unwrap_or(account.login)),
                    provider_id: Some(
                        official_provider
                            .map(|p| p.id.clone())
                            .unwrap_or_else(|| "openai".into()),
                    ),
                    provider_name: Some(
                        official_provider
                            .map(|p| p.name.clone())
                            .unwrap_or_else(|| "OpenAI".into()),
                    ),
                });
            }
        }
        if matches.len() == 1 {
            return Ok(matches.pop());
        }
        if matches.len() > 1 {
            return Ok(None);
        }
        let mut identity = native_account_identity(&auth);
        if let Some(native) = identity.as_mut() {
            if let Some(provider) = official_provider {
                native.provider_id = Some(provider.id.clone());
                native.provider_name = Some(provider.name.clone());
            }
        }
        return Ok(identity);
    }
    let Some(live_signature) = table.and_then(table_signature) else {
        return Ok(None);
    };
    let mut matches = Vec::new();
    for provider in providers.values() {
        let input = RowInput {
            settings: &provider.settings_config,
            official: crate::codex_config::is_codex_official_provider(provider)
                || provider.category.as_deref() == Some("official"),
            proxy_injected_oauth: provider.uses_proxy_injected_oauth(),
        };
        let Ok(projection) = CodexProjection::of(&input) else {
            continue;
        };
        if let Route::Custom { table, .. } = projection.route {
            if table_signature(&table).as_deref() == Some(&live_signature) {
                matches.push(provider_identity(provider));
            }
        }
    }
    Ok(if matches.len() == 1 {
        matches.pop()
    } else {
        None
    })
}

/// A heartbeat provides bounded coverage: never extrapolate past the last observation.
/// A restart, missed heartbeat, or identity change leaves the intervening time unknown.
/// `observed_at`, stored coverage, and source `event_at` use epoch milliseconds.
pub fn observe_identity(
    db: &Database,
    run_id: &str,
    identity: Option<&UsageIdentity>,
    observed_at: i64,
) -> Result<usize, AppError> {
    let source = source_key(&crate::codex_usage_source::get_codex_usage_source_dir());
    observe_identity_for_source(db, run_id, &source, identity, observed_at)
}
fn observe_identity_for_source(
    db: &Database,
    run_id: &str,
    source: &str,
    identity: Option<&UsageIdentity>,
    observed_at: i64,
) -> Result<usize, AppError> {
    let conn = lock_conn!(db.conn);
    let tx = conn.unchecked_transaction()?;
    let key = serde_json::to_string(&identity).map_err(|e| AppError::Config(e.to_string()))?;
    let previous: Option<(i64,String,i64,String)> = tx.query_row(
        "SELECT id,run_id,end_at,identity_key FROM usage_identity_observations WHERE source_key=?1 ORDER BY id DESC LIMIT 1",[source],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let continuous = previous.as_ref().is_some_and(|(_, run, last, k)| {
        run == run_id && k == &key && observed_at >= *last && observed_at - *last <= 15_000
    });
    let mut changed = 0;
    if continuous {
        let (id, _, last, _) = previous.unwrap();
        tx.execute(
            "UPDATE usage_identity_observations SET end_at=?1 WHERE id=?2",
            params![observed_at, id],
        )?;
        changed = reconcile_auto_tags_on_conn(&tx, source, id, last, observed_at)?;
    } else {
        let empty = UsageIdentity {
            account_id: None,
            account_name: None,
            provider_id: None,
            provider_name: None,
        };
        let identity = identity.unwrap_or(&empty);
        tx.execute("INSERT INTO usage_identity_observations(run_id,source_key,start_at,end_at,account_id,account_name,provider_id,provider_name,identity_key) VALUES(?1,?2,?3,?3,?4,?5,?6,?7,?8)",params![run_id,source,observed_at,identity.account_id,identity.account_name,identity.provider_id,identity.provider_name,key])?;
    }
    tx.commit()?;
    Ok(changed)
}
fn reconcile_auto_tags_on_conn(
    conn: &Connection,
    source: &str,
    observation_id: i64,
    start: i64,
    end: i64,
) -> Result<usize, AppError> {
    Ok(conn.execute("INSERT OR IGNORE INTO usage_record_attributions(request_id,account_id,account_name,provider_id,provider_name,method,tagged_at)
        SELECT l.request_id,o.account_id,o.account_name,o.provider_id,o.provider_name,'auto',CAST(strftime('%s','now') AS INTEGER)
        FROM proxy_request_logs l JOIN usage_record_sources s ON s.request_id=l.request_id
        JOIN usage_identity_observations o ON o.source_key=s.source_key AND s.event_at>=o.start_at AND s.event_at<o.end_at
        WHERE l.data_source='codex_session' AND s.source_key=?1 AND o.id=?2 AND s.event_at>=?3 AND s.event_at<?4 AND o.provider_id IS NOT NULL AND o.end_at>o.start_at AND NOT EXISTS (SELECT 1 FROM usage_record_attributions a WHERE a.request_id=l.request_id)",params![source,observation_id,start,end])?)
}
/// Called inside the import transaction; source and valid event time are retained for delayed scans.
pub(crate) fn record_imported_source_on_conn(
    conn: &Connection,
    request_id: &str,
    source: &Path,
    timestamp: Option<&str>,
) -> Result<(), AppError> {
    let key = source_key(source);
    let event_at = timestamp
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis());
    conn.execute("INSERT OR IGNORE INTO usage_record_sources(request_id,source_key,event_at) VALUES(?1,?2,?3)",params![request_id,key,event_at])?;
    conn.execute("INSERT OR IGNORE INTO usage_record_attributions(request_id,account_id,account_name,provider_id,provider_name,method,tagged_at)
        SELECT ?1,o.account_id,o.account_name,o.provider_id,o.provider_name,'auto',CAST(strftime('%s','now') AS INTEGER)
        FROM usage_identity_observations o WHERE o.source_key=?2 AND ?3>=o.start_at AND ?3<o.end_at AND o.provider_id IS NOT NULL AND o.end_at>o.start_at ORDER BY o.id DESC LIMIT 1",params![request_id,key,event_at])?;
    Ok(())
}

fn selected_requests(
    conn: &Connection,
    selector: &UsageAttributionSelector,
    only_untagged: bool,
) -> Result<Vec<String>, AppError> {
    use rusqlite::types::Value;
    let bounded = selector.request_ids.as_ref().is_some_and(|v| !v.is_empty())
        || selector
            .session_id
            .as_ref()
            .is_some_and(|v| !v.trim().is_empty())
        || selector.start_date.is_some()
        || selector.end_date.is_some();
    if !bounded {
        return Err(AppError::InvalidInput(
            "请选择记录、会话或时间范围后再标记".into(),
        ));
    }
    if selector
        .start_date
        .zip(selector.end_date)
        .is_some_and(|(s, e)| s > e)
    {
        return Err(AppError::InvalidInput("起始时间不能晚于结束时间".into()));
    }
    // Every visible Codex detail can be corrected, including retained legacy
    // request logs. Share the browse projection so previews match the view.
    let mut sql = "SELECT l.request_id FROM proxy_request_logs l LEFT JOIN usage_record_attributions a ON a.request_id=l.request_id LEFT JOIN providers p ON p.id=l.provider_id AND p.app_type=l.app_type WHERE l.app_type='codex'".to_string();
    sql.push_str(&format!(
        " AND ({})",
        crate::services::usage_stats::effective_usage_log_filter("l")
    ));
    let mut values: Vec<Value> = Vec::new();
    if let Some(ids) = &selector.request_ids {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if ids.len() > 900 {
            return Err(AppError::InvalidInput(
                "一次最多选择 900 条明细；批量标记请使用会话或时间范围".into(),
            ));
        }
        sql.push_str(&format!(
            " AND l.request_id IN ({})",
            vec!["?"; ids.len()].join(",")
        ));
        values.extend(ids.iter().cloned().map(Value::Text));
    }
    let effective_provider_id = "CASE WHEN a.request_id IS NOT NULL THEN a.provider_id WHEN l.provider_id='_codex_session' THEN NULL ELSE l.provider_id END";
    let effective_provider_name = "COALESCE(CASE WHEN a.request_id IS NOT NULL THEN a.provider_name WHEN l.provider_id='_codex_session' THEN NULL ELSE COALESCE(p.name,l.provider_id) END,'Unassigned')";
    for (column, value) in [
        ("l.session_id", &selector.session_id),
        (effective_provider_name, &selector.provider_name),
        (effective_provider_id, &selector.provider_id),
        (
            "COALESCE(NULLIF(l.pricing_model,''),l.model)",
            &selector.model,
        ),
        ("a.account_id", &selector.account_id),
    ] {
        if let Some(value) = value {
            if value == "__unassigned__"
                && (column == "a.account_id" || column == effective_provider_id)
            {
                sql.push_str(&format!(" AND {column} IS NULL"));
            } else {
                sql.push_str(&format!(" AND {column}=?"));
                values.push(Value::Text(value.clone()));
            }
        }
    }
    if let Some(start) = selector.start_date {
        sql.push_str(" AND l.created_at>=?");
        values.push(Value::Integer(start));
    }
    if let Some(end) = selector.end_date {
        sql.push_str(" AND l.created_at<=?");
        values.push(Value::Integer(end));
    }
    if only_untagged || selector.attribution.as_deref() == Some("untagged") {
        sql.push_str(" AND a.request_id IS NULL");
    }
    match selector.attribution.as_deref() {
        Some("auto" | "manual") => {
            sql.push_str(" AND a.method=?");
            values.push(Value::Text(selector.attribution.clone().unwrap()));
        }
        Some("untagged" | "all") | None => {}
        Some(_) => return Err(AppError::InvalidInput("无效的归属筛选".into())),
    }
    sql.push_str(" ORDER BY l.created_at,l.request_id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values), |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
pub fn count_usage_attribution_records(
    db: &Database,
    selector: &UsageAttributionSelector,
    only_untagged: bool,
) -> Result<usize, AppError> {
    let conn = lock_conn!(db.conn);
    Ok(selected_requests(&conn, selector, only_untagged)?.len())
}
fn read_tag(conn: &Connection, request_id: &str) -> Result<Option<StoredTag>, AppError> {
    Ok(conn.query_row("SELECT account_id,account_name,provider_id,provider_name,method,tagged_at FROM usage_record_attributions WHERE request_id=?1",[request_id],|r| Ok(StoredTag {identity:UsageIdentity {account_id:r.get(0)?,account_name:r.get(1)?,provider_id:r.get(2)?,provider_name:r.get(3)?},method:r.get(4)?,tagged_at:r.get(5)?})).optional()?)
}
fn write_tag(conn: &Connection, request_id: &str, tag: &StoredTag) -> Result<(), AppError> {
    conn.execute("INSERT INTO usage_record_attributions(request_id,account_id,account_name,provider_id,provider_name,method,tagged_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(request_id) DO UPDATE SET account_id=excluded.account_id,account_name=excluded.account_name,provider_id=excluded.provider_id,provider_name=excluded.provider_name,method=excluded.method,tagged_at=excluded.tagged_at",params![request_id,tag.identity.account_id,tag.identity.account_name,tag.identity.provider_id,tag.identity.provider_name,tag.method,tag.tagged_at])?;
    Ok(())
}
pub fn apply_usage_attribution(
    db: &Database,
    selector: &UsageAttributionSelector,
    target: &UsageAttributionChoice,
    only_untagged: bool,
) -> Result<UsageAttributionResult, AppError> {
    if target.identity.provider_id.is_none() || target.identity.account_id.is_none() {
        return Err(AppError::InvalidInput("请选择有效账户和供应商".into()));
    }
    let conn = lock_conn!(db.conn);
    let tx = conn.unchecked_transaction()?;
    let ids = selected_requests(&tx, selector, only_untagged)?;
    let now = chrono::Utc::now().timestamp();
    tx.execute(
        "INSERT INTO usage_attribution_actions(created_at) VALUES(?1)",
        [now],
    )?;
    let action_id = tx.last_insert_rowid();
    let tag = StoredTag {
        identity: target.identity.clone(),
        method: "manual".into(),
        tagged_at: now,
    };
    let after = serde_json::to_string(&tag).map_err(|e| AppError::Config(e.to_string()))?;
    for id in &ids {
        let before = read_tag(&tx, id)?
            .map(|tag| serde_json::to_string(&tag))
            .transpose()
            .map_err(|e| AppError::Config(e.to_string()))?;
        write_tag(&tx, id, &tag)?;
        tx.execute("INSERT INTO usage_attribution_changes(action_id,request_id,before_json,after_json) VALUES(?1,?2,?3,?4)",params![action_id,id,before,after])?;
    }
    tx.commit()?;
    Ok(UsageAttributionResult {
        action_id,
        count: ids.len(),
    })
}
/// Restore only still-matching values so undo cannot erase a newer correction.
pub fn undo_usage_attribution(db: &Database, action_id: i64) -> Result<usize, AppError> {
    let conn = lock_conn!(db.conn);
    let tx = conn.unchecked_transaction()?;
    let undone: Option<Option<i64>> = tx
        .query_row(
            "SELECT undone_at FROM usage_attribution_actions WHERE id=?1",
            [action_id],
            |r| r.get(0),
        )
        .optional()?;
    match undone {
        None => return Err(AppError::InvalidInput("标记操作不存在".into())),
        Some(Some(_)) => return Ok(0),
        _ => {}
    }
    let changes = {
        let mut stmt=tx.prepare("SELECT request_id,before_json,after_json FROM usage_attribution_changes WHERE action_id=?1")?;
        let rows = stmt.query_map([action_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut count = 0;
    for (id, before, after) in changes {
        let after: StoredTag =
            serde_json::from_str(&after).map_err(|e| AppError::Config(e.to_string()))?;
        if read_tag(&tx, &id)?.as_ref() != Some(&after) {
            continue;
        }
        // Distinct actions within one second can have identical tags. A later action
        // still owns the correction even then; never undo underneath it.
        let superseded:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_attribution_changes c JOIN usage_attribution_actions a ON a.id=c.action_id WHERE c.request_id=?1 AND c.action_id>?2 AND a.undone_at IS NULL)",params![id,action_id],|r|r.get(0))?;
        if superseded {
            continue;
        }
        if let Some(before) = before {
            write_tag(
                &tx,
                &id,
                &serde_json::from_str(&before).map_err(|e| AppError::Config(e.to_string()))?,
            )?;
        } else {
            tx.execute(
                "DELETE FROM usage_record_attributions WHERE request_id=?1",
                [&id],
            )?;
        }
        count += 1;
    }
    tx.execute(
        "UPDATE usage_attribution_actions SET undone_at=?1 WHERE id=?2",
        params![chrono::Utc::now().timestamp(), action_id],
    )?;
    tx.commit()?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(name: &str) -> UsageIdentity {
        UsageIdentity {
            account_id: Some(format!("account-{name}")),
            account_name: Some(name.into()),
            provider_id: Some(format!("provider-{name}")),
            provider_name: Some(name.into()),
        }
    }
    fn log(db: &Database, id: &str, event: i64, source: &Path) -> Result<(), AppError> {
        let conn = lock_conn!(db.conn);
        conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,request_model,input_tokens,output_tokens,latency_ms,status_code,session_id,created_at,data_source) VALUES(?1,'_codex_session','codex','model','model',10,5,0,200,'session',?2,'codex_session')",params![id,event])?;
        let timestamp = chrono::DateTime::from_timestamp(event, 0)
            .unwrap()
            .to_rfc3339();
        record_imported_source_on_conn(&conn, id, source, Some(&timestamp))
    }
    fn tag(db: &Database, id: &str) -> Option<StoredTag> {
        let conn = db.conn.lock().unwrap();
        read_tag(&conn, id).unwrap()
    }
    #[test]
    fn attribution_only_covers_observed_run_intervals_and_event_time() -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = tempfile::tempdir().unwrap();
        let key = source_key(source.path());
        let a = identity("A");
        let b = identity("B");
        observe_identity_for_source(&db, "run-1", &key, Some(&a), 100000)?;
        log(&db, "before", 99, source.path())?;
        log(&db, "pending", 103, source.path())?;
        assert!(tag(&db, "before").is_none());
        assert!(tag(&db, "pending").is_none());
        assert_eq!(
            observe_identity_for_source(&db, "run-1", &key, Some(&a), 105000)?,
            1
        );
        assert_eq!(tag(&db, "pending").unwrap().identity, a);
        log(&db, "delay", 101, source.path())?;
        assert_eq!(tag(&db, "delay").unwrap().identity, a);
        observe_identity_for_source(&db, "run-2", &key, Some(&b), 110000)?;
        log(&db, "offline", 107, source.path())?;
        log(&db, "newrun", 112, source.path())?;
        observe_identity_for_source(&db, "run-2", &key, Some(&b), 115000)?;
        assert!(tag(&db, "offline").is_none());
        assert_eq!(tag(&db, "newrun").unwrap().identity, b);
        observe_identity_for_source(&db, "run-2", &key, Some(&b), 160000)?;
        log(&db, "longgap", 120, source.path())?;
        assert!(tag(&db, "longgap").is_none());
        observe_identity_for_source(&db, "run-2", &key, None, 165000)?;
        log(&db, "unknown", 163, source.path())?;
        assert!(tag(&db, "unknown").is_none());
        Ok(())
    }
    #[test]
    fn attribution_manual_precedence_action_undo_and_rebuild_survival() -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = tempfile::tempdir().unwrap();
        let key = source_key(source.path());
        log(&db, "r", 102, source.path())?;
        let selector = UsageAttributionSelector {
            request_ids: Some(vec!["r".into()]),
            ..Default::default()
        };
        let first = apply_usage_attribution(&db, &selector, &choice(identity("manual-A")), true)?;
        let second = apply_usage_attribution(&db, &selector, &choice(identity("manual-B")), false)?;
        assert_eq!(undo_usage_attribution(&db, first.action_id)?, 0);
        observe_identity_for_source(&db, "run", &key, Some(&identity("auto")), 100000)?;
        observe_identity_for_source(&db, "run", &key, Some(&identity("auto")), 105000)?;
        assert_eq!(tag(&db, "r").unwrap().identity, identity("manual-B"));
        {
            let conn = lock_conn!(db.conn);
            crate::services::session_usage_codex::reset_codex_usage_on_conn(&conn, source.path())?;
        }
        assert_eq!(tag(&db, "r").unwrap().identity, identity("manual-B"));
        log(&db, "r", 102, source.path())?;
        assert_eq!(tag(&db, "r").unwrap().identity, identity("manual-B"));
        assert_eq!(undo_usage_attribution(&db, second.action_id)?, 1);
        assert_eq!(tag(&db, "r").unwrap().identity, identity("manual-A"));
        Ok(())
    }
    #[test]
    fn attribution_manual_unknown_bucket_is_bounded_and_all_filter_valid() -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = tempfile::tempdir().unwrap();
        log(&db, "unknown", 102, source.path())?;
        log(&db, "known", 103, source.path())?;
        log(&db, "later", 200, source.path())?;
        let known = UsageAttributionSelector {
            request_ids: Some(vec!["known".into()]),
            ..Default::default()
        };
        apply_usage_attribution(&db, &known, &choice(identity("A")), true)?;
        let bucket = UsageAttributionSelector {
            start_date: Some(100),
            end_date: Some(110),
            account_id: Some("__unassigned__".into()),
            provider_id: Some("__unassigned__".into()),
            attribution: Some("all".into()),
            ..Default::default()
        };
        assert_eq!(count_usage_attribution_records(&db, &bucket, true)?, 1);
        assert_eq!(
            apply_usage_attribution(&db, &bucket, &choice(identity("B")), true)?.count,
            1
        );
        assert!(tag(&db, "later").is_none());
        assert_eq!(tag(&db, "known").unwrap().identity, identity("A"));
        assert!(
            count_usage_attribution_records(&db, &UsageAttributionSelector::default(), true)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn attribution_manual_selection_matches_visible_legacy_codex_records() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs
                 (request_id,provider_id,app_type,model,input_tokens,output_tokens,total_cost_usd,latency_ms,status_code,created_at,data_source)
                 VALUES ('legacy','legacy-provider','codex','model',10,5,'0.1',0,200,100,'proxy')", [],
            )?;
            conn.execute(
                "INSERT INTO proxy_request_logs
                 (request_id,provider_id,app_type,model,input_tokens,output_tokens,total_cost_usd,latency_ms,status_code,created_at,data_source)
                 VALUES ('hidden-duplicate','_codex_session','codex','model',10,5,'0.1',0,200,101,'codex_session')", [],
            )?;
        }
        let selection = UsageAttributionSelector {
            start_date: Some(99),
            end_date: Some(102),
            provider_id: Some("legacy-provider".into()),
            provider_name: Some("legacy-provider".into()),
            account_id: Some("__unassigned__".into()),
            attribution: Some("all".into()),
            ..Default::default()
        };
        assert_eq!(count_usage_attribution_records(&db, &selection, true)?, 1);
        assert_eq!(
            apply_usage_attribution(&db, &selection, &choice(identity("chosen")), true)?.count,
            1
        );
        assert_eq!(tag(&db, "legacy").unwrap().identity, identity("chosen"));
        assert!(tag(&db, "hidden-duplicate").is_none());
        Ok(())
    }
    #[test]
    fn attribution_provider_filters_match_browse_for_annotations_and_legacy_sources(
    ) -> Result<(), AppError> {
        use crate::services::usage_records::{
            query_usage_records, UsageRecordFilters, UsageRecordView,
        };
        use std::collections::BTreeSet;
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute("INSERT INTO providers(id,app_type,name,settings_config) VALUES('legacy-provider','codex','Legacy API','{}')",[])?;
            for (index, id, provider, source) in [
                (0, "raw-known", "legacy-provider", "proxy"),
                (1, "raw-deleted", "deleted-provider", "proxy"),
                (2, "annotated", "legacy-provider", "proxy"),
                (3, "annotated-null", "legacy-provider", "proxy"),
                (4, "session-unknown", "_codex_session", "codex_session"),
            ] {
                conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,input_tokens,output_tokens,total_cost_usd,latency_ms,status_code,created_at,data_source) VALUES(?1,?2,'codex','model',?3,5,'0.1',0,200,?4,?5)",params![id,provider,100+index,100+index,source])?;
            }
            write_tag(
                &conn,
                "annotated",
                &StoredTag {
                    identity: identity("snapshot"),
                    method: "manual".into(),
                    tagged_at: 110,
                },
            )?;
            write_tag(
                &conn,
                "annotated-null",
                &StoredTag {
                    identity: UsageIdentity {
                        account_id: Some("account-only".into()),
                        account_name: Some("Account".into()),
                        provider_id: None,
                        provider_name: None,
                    },
                    method: "manual".into(),
                    tagged_at: 110,
                },
            )?;
        }
        for (provider_id, provider_name, expected) in [
            (Some("legacy-provider"), None, vec!["raw-known"]),
            (None, Some("Legacy API"), vec!["raw-known"]),
            (
                Some("deleted-provider"),
                Some("deleted-provider"),
                vec!["raw-deleted"],
            ),
            (
                Some("provider-snapshot"),
                Some("snapshot"),
                vec!["annotated"],
            ),
            (
                Some("__unassigned__"),
                Some("Unassigned"),
                vec!["annotated-null", "session-unknown"],
            ),
        ] {
            let selector = UsageAttributionSelector {
                start_date: Some(99),
                end_date: Some(110),
                provider_id: provider_id.map(str::to_owned),
                provider_name: provider_name.map(str::to_owned),
                attribution: Some("all".into()),
                ..Default::default()
            };
            let conn = lock_conn!(db.conn);
            let selected = selected_requests(&conn, &selector, false)?
                .into_iter()
                .collect::<BTreeSet<_>>();
            let filters = UsageRecordFilters {
                app_type: Some("codex".into()),
                start_date: selector.start_date,
                end_date: selector.end_date,
                provider_id: selector.provider_id.clone(),
                provider_name: selector.provider_name.clone(),
                attribution: Some("all".into()),
                ..Default::default()
            };
            let browse =
                query_usage_records(&conn, &filters, UsageRecordView::Details, 0, 100, "UTC")?;
            let visible = browse
                .data
                .into_iter()
                .filter_map(|r| r.request_id)
                .collect::<BTreeSet<_>>();
            assert_eq!(selected, expected.into_iter().map(str::to_owned).collect());
            assert_eq!(
                selected, visible,
                "manual selection must match visible effective provider rows"
            );
        }
        let selector = UsageAttributionSelector {
            start_date: Some(99),
            end_date: Some(110),
            provider_id: Some("legacy-provider".into()),
            provider_name: Some("Legacy API".into()),
            ..Default::default()
        };
        assert_eq!(
            apply_usage_attribution(&db, &selector, &choice(identity("chosen")), true)?.count,
            1
        );
        assert_eq!(tag(&db, "raw-known").unwrap().identity, identity("chosen"));
        assert_eq!(
            tag(&db, "annotated").unwrap().identity,
            identity("snapshot")
        );
        Ok(())
    }
    #[test]
    fn attribution_missing_event_timestamp_and_other_source_stay_unknown() -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let key = source_key(source.path());
        observe_identity_for_source(&db, "run", &key, Some(&identity("A")), 100000)?;
        log(&db, "other", 102, other.path())?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,latency_ms,status_code,created_at,data_source) VALUES('no-time','_codex_session','codex','model',0,200,102,'codex_session')",[])?;
            record_imported_source_on_conn(&conn, "no-time", source.path(), None)?;
        }
        observe_identity_for_source(&db, "run", &key, Some(&identity("A")), 105000)?;
        assert!(tag(&db, "other").is_none());
        assert!(tag(&db, "no-time").is_none());
        Ok(())
    }
    #[test]
    fn attribution_activation_boundary_retains_millisecond_precision() -> Result<(), AppError> {
        let db = Database::memory()?;
        let source = tempfile::tempdir().unwrap();
        let key = source_key(source.path());
        observe_identity_for_source(&db, "run", &key, Some(&identity("A")), 100_900)?;
        log(&db, "early", 100, source.path())?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,latency_ms,status_code,created_at,data_source) VALUES('late','_codex_session','codex','model',0,200,100,'codex_session')",[])?;
            record_imported_source_on_conn(
                &conn,
                "late",
                source.path(),
                Some("1970-01-01T00:01:40.950Z"),
            )?;
        }
        observe_identity_for_source(&db, "run", &key, Some(&identity("A")), 105_900)?;
        assert!(tag(&db, "early").is_none());
        assert!(tag(&db, "late").is_some());
        Ok(())
    }
    #[tokio::test]
    async fn attribution_managed_match_requires_user_and_workspace_without_writes() {
        let dir = tempfile::tempdir().unwrap();
        let manager = CodexOAuthManager::new(dir.path().to_path_buf());
        let token_a = crate::codex_config::test_codex_id_token("user-a");
        let token_b = crate::codex_config::test_codex_id_token("user-b");
        manager
            .add_test_account_with_workspace_and_access_token(
                "a",
                "shared-workspace",
                "token-a",
                Some(&token_a),
            )
            .await
            .unwrap();
        manager
            .add_test_account_with_workspace_and_access_token(
                "b",
                "shared-workspace",
                "token-b",
                Some(&token_b),
            )
            .await
            .unwrap();
        let before = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (p.clone(), std::fs::read(p).unwrap())
            })
            .collect::<Vec<_>>();
        let auth = serde_json::json!({"auth_mode":"chatgpt","tokens":{"id_token":token_a,"account_id":"shared-workspace"}});
        assert!(account_matches_native(&manager, &auth, "a").await);
        assert!(!account_matches_native(&manager, &auth, "b").await);
        let wrong_workspace = serde_json::json!({"auth_mode":"chatgpt","tokens":{"id_token":crate::codex_config::test_codex_id_token("user-a"),"account_id":"other-workspace"}});
        assert!(!account_matches_native(&manager, &wrong_workspace, "a").await);
        for (path, bytes) in before {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }
    #[test]
    fn attribution_native_auth_parsing_does_not_accept_retained_oauth_for_api_auth() {
        let auth = serde_json::json!({"auth_mode":"apikey","OPENAI_API_KEY":"secret","tokens":{"id_token":crate::codex_config::test_codex_id_token("user"),"account_id":"workspace"}});
        assert!(native_account_identity(&auth).is_none());
    }
}
