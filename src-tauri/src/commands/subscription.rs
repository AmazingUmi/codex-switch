use std::str::FromStr;
use tauri::{Emitter, State};

use crate::services::usage_cache::UsageCache;

use crate::app_config::AppType;
use crate::services::subscription::SubscriptionQuota;
use crate::store::AppState;

/// 查询官方订阅额度
///
/// 读取 CLI 工具已有的 OAuth 凭据并调用官方 API 获取使用额度。
/// `Ok`（成功或确定性失败）写入 `UsageCache`、通知托盘刷新并 emit
/// `usage-cache-updated`，让前端 React Query 与托盘共享同一份最新数据；失败
/// 快照写入后 `format_subscription_summary` 会通过 `success=false` 守卫返回
/// `None`，托盘 suffix 自然消失，避免长期滞留旧配额数字。
/// Native Codex publishes the shared projection on failure too, preserving the
/// successful timestamp and reporting refresh failure to both consumers.
/// Other tools retain their existing rejection/keep-last-good behavior.
#[tauri::command]
pub async fn get_subscription_quota(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    tool: String,
    force_refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    // Capture the active native provider before awaiting; a switch in flight
    // must not attach the previous account's response to the newly selected row.
    let native_provider_id = (tool == "codex")
        .then(|| {
            crate::mode::current::provider_for(
                &state.db,
                &AppType::Codex,
                crate::mode::current::Purpose::InUse,
            )
            .ok()
            .flatten()
            .and_then(|id| {
                state
                    .db
                    .get_provider_by_id(&id, "codex")
                    .ok()
                    .flatten()
                    .filter(crate::tray::provider_uses_official_subscription)
                    .filter(crate::services::provider::codex_direct::is_official)
                    .map(|_| id)
            })
        })
        .flatten();
    let inner = if let Some(provider_id) = &native_provider_id {
        query_native_codex_quota_cached(
            &state.usage_cache,
            provider_id,
            force_refresh.unwrap_or(true),
        )
        .await
    } else {
        crate::services::subscription::get_subscription_quota(&tool).await
    };
    if let Some(id) = &native_provider_id {
        if crate::mode::current::provider_for(
            &state.db,
            &AppType::Codex,
            crate::mode::current::Purpose::InUse,
        )
        .ok()
        .flatten()
        .as_ref()
            != Some(id)
        {
            return Err("Native Codex provider changed during quota refresh".into());
        }
    }
    let native_snapshot = native_provider_id.as_ref().and_then(|id| {
        let scope = crate::services::subscription::native_codex_file_scope()?;
        let entry = state.usage_cache.native_codex_entry(id, &scope)?;
        let mut snapshot = entry.snapshot(
            chrono::Utc::now().timestamp_millis(),
            crate::settings::get_settings().quota_refresh_interval_seconds,
            0,
        );
        snapshot.quota.tool = "codex".into();
        Some(snapshot)
    });
    let published = if let Some(snapshot) = native_snapshot {
        Ok(serde_json::to_value(snapshot).map_err(|e| e.to_string())?)
    } else {
        inner
            .clone()
            .and_then(|snapshot| serde_json::to_value(snapshot).map_err(|e| e.to_string()))
    };
    if let Ok(snapshot) = &published {
        if let Ok(app_type) = AppType::from_str(&tool) {
            let payload = serde_json::json!({
                "kind": "subscription",
                "appType": app_type.as_str(),
                "data": snapshot,
            });
            if let Err(e) = app.emit("usage-cache-updated", payload) {
                log::error!("emit usage-cache-updated (subscription) 失败: {e}");
            }
            if let Ok(quota) = &inner {
                state.usage_cache.put_subscription(app_type, quota.clone());
            }
            crate::tray::schedule_tray_refresh(&app);
        }
    }
    if inner.is_err() {
        if let Ok(app_type) = AppType::from_str(&tool) {
            state
                .usage_cache
                .mark_subscription_transient_failure(app_type);
        }
    }
    crate::tray::update_tray_display(&app);
    published
}

/// Shared native Codex query used by frontend scripts and the background tray.
/// The cache key belongs to the provider captured at dispatch time.
pub(crate) async fn query_native_codex_quota_cached(
    cache: &UsageCache,
    provider_id: &str,
    force_refresh: bool,
) -> Result<SubscriptionQuota, String> {
    let Some(capture) = crate::services::subscription::native_codex_file_credentials() else {
        cache.invalidate_native_codex(provider_id);
        // Preserve the existing frontend native query, while the ring stays
        // unavailable for sources whose identity cannot be cheaply verified.
        return crate::services::subscription::get_subscription_quota("codex").await;
    };
    let scope = capture.scope.clone();
    let interval = crate::settings::get_settings().quota_refresh_interval_seconds;
    let max_age = if force_refresh || cache.native_codex_entry(provider_id, &scope).is_none() {
        std::time::Duration::ZERO
    } else if interval == 0 {
        std::time::Duration::MAX
    } else {
        std::time::Duration::from_secs(u64::from(interval))
    };
    let result = cache
        .quota_with_max_age(
            format!("native-codex:{provider_id}:{scope}"),
            max_age,
            async {
                let result =
                    crate::services::subscription::query_native_codex_file_quota(capture).await;
                if crate::services::subscription::native_codex_file_scope().as_deref()
                    != Some(scope.as_str())
                {
                    return Err("Native Codex authentication changed during quota refresh".into());
                }
                match &result {
                    Ok(quota) => cache.put_native_codex(
                        provider_id.to_string(),
                        scope.clone(),
                        quota.clone(),
                    ),
                    Err(error) => {
                        cache.mark_native_codex_transient_failure(provider_id, &scope, error)
                    }
                }
                result
            },
        )
        .await;
    if crate::services::subscription::native_codex_file_scope().as_deref() != Some(scope.as_str()) {
        cache.invalidate_native_codex(provider_id);
        return Err("Native Codex authentication changed during quota refresh".into());
    }
    result
}
