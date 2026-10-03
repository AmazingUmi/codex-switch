//! Native, account-scoped quota projection for the menu bar. The worker lives
//! independently of the webview and never rebuilds an open tray menu.

use tauri::Manager;

use crate::app_config::AppType;
use crate::services::subscription::{QuotaTier, TIER_FIVE_HOUR, TIER_SEVEN_DAY};
use crate::services::usage_cache::{QuotaCacheEntry, QuotaSnapshotStatus};
use crate::store::AppState;

#[cfg(test)]
const FRESH_FOR_MS: i64 = 120_000;
#[cfg(test)]
const STALE_FOR_MS: i64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayQuotaStatus {
    Ready,
    Stale,
    Unavailable,
    Expired,
    Disabled,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TrayQuotaWindowSnapshot {
    pub(crate) remaining: f64,
    pub(crate) resets_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TrayQuotaSnapshot {
    #[cfg_attr(
        all(not(target_os = "macos"), not(test)),
        expect(
            dead_code,
            reason = "Read by the macOS menu-bar renderer and portable fixtures"
        )
    )]
    pub(crate) account_label: Option<String>,
    #[cfg_attr(
        all(not(target_os = "macos"), not(test)),
        expect(
            dead_code,
            reason = "Read by the macOS menu-bar renderer and portable fixtures"
        )
    )]
    pub(crate) five_hour: Option<TrayQuotaWindowSnapshot>,
    #[cfg_attr(
        all(not(target_os = "macos"), not(test)),
        expect(
            dead_code,
            reason = "Read by the macOS menu-bar renderer and portable fixtures"
        )
    )]
    pub(crate) seven_day: Option<TrayQuotaWindowSnapshot>,
    pub(crate) status: TrayQuotaStatus,
    /// Timestamp of the successful query, never a failed retry or reset time.
    pub(crate) updated_at: Option<i64>,
}

impl TrayQuotaSnapshot {
    fn empty(status: TrayQuotaStatus, account_label: Option<String>) -> Self {
        Self {
            account_label,
            five_hour: None,
            seven_day: None,
            status,
            updated_at: None,
        }
    }
}

/// Resolve the committed provider for every read. Managed accounts only read
/// their explicit binding; neither the OAuth default nor CLI cache is a fallback.
pub(crate) fn snapshot(app: &tauri::AppHandle) -> TrayQuotaSnapshot {
    let Some(state) = app.try_state::<AppState>() else {
        return TrayQuotaSnapshot::empty(TrayQuotaStatus::Unavailable, None);
    };
    let provider = crate::mode::current::provider_for(
        &state.db,
        &AppType::Codex,
        crate::mode::current::Purpose::InUse,
    )
    .ok()
    .flatten()
    .and_then(|id| state.db.get_provider_by_id(&id, "codex").ok().flatten());
    let Some(provider) = provider else {
        return TrayQuotaSnapshot::empty(TrayQuotaStatus::Unavailable, None);
    };
    let label = Some(provider.name.clone());
    match source_entry(&provider, &state.usage_cache) {
        Ok(entry) => project_with_interval(
            entry.as_ref(),
            label,
            now_millis(),
            crate::settings::get_settings().quota_refresh_interval_seconds,
        ),
        Err(status) => TrayQuotaSnapshot::empty(status, label),
    }
}

fn source_entry(
    provider: &crate::provider::Provider,
    cache: &crate::services::usage_cache::UsageCache,
) -> Result<Option<QuotaCacheEntry>, TrayQuotaStatus> {
    let managed = crate::tray::managed_codex_account_id(provider);
    if let Some(id) = managed {
        if crate::tray::tray_usage_source(&AppType::Codex, provider).is_none() {
            return Err(TrayQuotaStatus::Disabled);
        }
        return Ok(cache.codex_oauth_entry(&id));
    }
    if !crate::codex_config::is_codex_official_provider(provider) {
        return Err(TrayQuotaStatus::Unsupported);
    }
    let usage_script = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.usage_script.as_ref());
    if usage_script.is_some_and(|script| !script.enabled) {
        return Err(TrayQuotaStatus::Disabled);
    }
    if !crate::tray::provider_uses_official_subscription(provider) {
        return Err(TrayQuotaStatus::Unsupported);
    }
    let Some(scope) = crate::services::subscription::native_codex_file_scope() else {
        return Err(TrayQuotaStatus::Unavailable);
    };
    Ok(cache.native_codex_entry(&provider.id, &scope))
}

/// The native menu uses the same identity/freshness decision as the ring.
/// Keep the existing monthly window available without relabeling it as weekly.
pub(crate) fn menu_summary(
    provider: &crate::provider::Provider,
    cache: &crate::services::usage_cache::UsageCache,
    language: &str,
) -> Option<String> {
    let entry = match source_entry(provider, cache) {
        Err(TrayQuotaStatus::Unsupported | TrayQuotaStatus::Disabled) => return None,
        Ok(entry) => entry,
        Err(_) => None,
    };
    Some(remaining_menu_text(
        entry.as_ref(),
        language,
        now_millis(),
        crate::settings::get_settings().quota_refresh_interval_seconds,
    ))
}

fn remaining_menu_text(
    entry: Option<&QuotaCacheEntry>,
    language: &str,
    now: i64,
    interval: u32,
) -> String {
    let prefix = match language {
        "en" => "Remaining",
        "ja" => "残り",
        "zh-TW" => "剩餘",
        _ => "剩余",
    };
    let snapshot = project_with_interval(entry, None, now, interval);
    let parts = if matches!(
        snapshot.status,
        TrayQuotaStatus::Ready | TrayQuotaStatus::Stale
    ) {
        entry
            .and_then(|e| e.last_good.as_ref())
            .map(|quota| {
                [
                    ("5h", TIER_FIVE_HOUR, 18_000),
                    ("7d", TIER_SEVEN_DAY, 604_800),
                    (
                        "30d",
                        crate::services::subscription::TIER_THIRTY_DAY,
                        2_592_000,
                    ),
                ]
                .into_iter()
                .filter_map(|(label, name, duration)| {
                    let window = window(&quota.tiers, name, duration)?;
                    Some(format!(
                        "{label} {}",
                        crate::tray_display::remaining_text(
                            Some(window.remaining),
                            snapshot.status == TrayQuotaStatus::Stale
                        )
                    ))
                })
                .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    format!(
        "{prefix} {}",
        if parts.is_empty() {
            "—".into()
        } else {
            parts.join(" · ")
        }
    )
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn window(tiers: &[QuotaTier], name: &str, seconds: i64) -> Option<TrayQuotaWindowSnapshot> {
    let tier = tiers.iter().find(|tier| {
        tier.name == name
            && tier
                .window_duration_seconds
                .is_none_or(|duration| duration == seconds)
            && tier.utilization.is_finite()
            && (0.0..=100.0).contains(&tier.utilization)
    })?;
    Some(TrayQuotaWindowSnapshot {
        remaining: 100.0 - tier.utilization,
        resets_at: tier.resets_at.clone(),
    })
}

#[cfg(test)]
fn project(entry: Option<&QuotaCacheEntry>, label: Option<String>, now: i64) -> TrayQuotaSnapshot {
    project_with_interval(entry, label, now, 60)
}

fn project_with_interval(
    entry: Option<&QuotaCacheEntry>,
    label: Option<String>,
    now: i64,
    interval: u32,
) -> TrayQuotaSnapshot {
    let Some(entry) = entry else {
        return TrayQuotaSnapshot::empty(TrayQuotaStatus::Unavailable, label);
    };
    let projected = entry.snapshot(now, interval, 0);
    let status = match projected.refresh_state.status {
        QuotaSnapshotStatus::Ready => TrayQuotaStatus::Ready,
        QuotaSnapshotStatus::Stale => TrayQuotaStatus::Stale,
        QuotaSnapshotStatus::Unavailable => TrayQuotaStatus::Unavailable,
        QuotaSnapshotStatus::Expired => TrayQuotaStatus::Expired,
    };
    if !projected.quota.success {
        let mut result = TrayQuotaSnapshot::empty(status, label);
        result.updated_at = projected.quota.queried_at;
        return result;
    }
    let five_hour = window(&projected.quota.tiers, TIER_FIVE_HOUR, 18_000);
    let seven_day = window(&projected.quota.tiers, TIER_SEVEN_DAY, 604_800);
    let month = window(
        &projected.quota.tiers,
        crate::services::subscription::TIER_THIRTY_DAY,
        2_592_000,
    );
    let status = if five_hour.is_none() && seven_day.is_none() && month.is_none() {
        TrayQuotaStatus::Unavailable
    } else {
        status
    };
    TrayQuotaSnapshot {
        account_label: label,
        five_hour,
        seven_day,
        status,
        updated_at: projected.quota.queried_at,
    }
}

static WORKER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WORKER_WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();

pub(crate) fn start_worker(app: &tauri::AppHandle) {
    {
        use std::sync::atomic::Ordering;
        if WORKER_STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        let wake = WORKER_WAKE.get_or_init(tokio::sync::Notify::new);
        tauri::async_runtime::spawn(async move {
            let mut requested = true;
            loop {
                let settings = crate::settings::get_settings();
                // Turning off polling must not suppress an explicit account
                // switch, login or settings change that wakes this worker.
                if requested || settings.quota_refresh_interval_seconds > 0 {
                    refresh_current(&app, requested).await;
                }
                crate::tray::update_tray_display(&app);
                tokio::select! {
                    _ = wake.notified() => { requested = true; },
                    _ = tokio::time::sleep(std::time::Duration::from_secs(u64::from(settings.quota_refresh_interval_seconds.max(30)))) => { requested = false; },
                }
            }
        });
    }
}

/// A notify permit coalesces rapid changes, and survives an in-flight refresh.
/// The next iteration resolves the new binding rather than repeating the old one.
pub(crate) fn request_refresh(app: &tauri::AppHandle) {
    crate::tray::update_tray_display(app);
    WORKER_WAKE
        .get_or_init(tokio::sync::Notify::new)
        .notify_one();
}

async fn refresh_current(app: &tauri::AppHandle, requested: bool) {
    if !requested && snapshot(app).status == TrayQuotaStatus::Expired {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let current = crate::mode::current::provider_for(
        &state.db,
        &AppType::Codex,
        crate::mode::current::Purpose::InUse,
    )
    .ok()
    .flatten()
    .and_then(|id| state.db.get_provider_by_id(&id, "codex").ok().flatten());
    let Some(current) = current else {
        return;
    };
    let result = match crate::tray::tray_usage_source(&AppType::Codex, &current) {
        Some(crate::tray::TrayUsageSource::ManagedCodex(account_id)) => {
            let Some(oauth) = app.try_state::<crate::commands::CodexOAuthState>() else {
                return;
            };
            crate::commands::get_codex_oauth_quota(
                app.clone(),
                state,
                Some(account_id),
                oauth,
                Some(false),
            )
            .await
            .map(|_| ())
        }
        Some(crate::tray::TrayUsageSource::Script)
            if crate::codex_config::is_codex_official_provider(&current)
                && crate::tray::provider_uses_official_subscription(&current) =>
        {
            if crate::services::subscription::native_codex_file_scope().is_none() {
                return;
            }
            crate::commands::get_subscription_quota(app.clone(), state, "codex".into(), Some(false))
                .await
                .map(|_| ())
        }
        _ => return,
    };
    if let Err(error) = result {
        log::debug!("[TrayQuota] quota refresh failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::subscription::CredentialStatus;
    use crate::services::subscription::SubscriptionQuota;
    use crate::services::usage_cache::UsageCache;

    const NOW: i64 = 1_800_000_000_000;

    fn quota(used: f64, queried_at: i64) -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "codex_oauth".into(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: vec![QuotaTier {
                name: TIER_FIVE_HOUR.into(),
                utilization: used,
                resets_at: Some(
                    chrono::DateTime::from_timestamp_millis(NOW + 60_000)
                        .unwrap()
                        .to_rfc3339(),
                ),
                window_duration_seconds: Some(18_000),
                used_value_usd: None,
                max_value_usd: None,
            }],
            extra_usage: None,
            error: None,
            queried_at: Some(queried_at),
        }
    }

    fn read(cache: &UsageCache, id: &str, now: i64) -> TrayQuotaSnapshot {
        project(cache.codex_oauth_entry(id).as_ref(), Some(id.into()), now)
    }

    #[test]
    fn menu_uses_remaining_freshness_and_keeps_monthly_window() {
        let cache = UsageCache::new();
        cache.put_codex_oauth("a".into(), quota(64.0, NOW));
        let summary = |at| remaining_menu_text(cache.codex_oauth_entry("a").as_ref(), "zh", at, 60);
        assert_eq!(summary(NOW), "剩余 5h 36%");
        cache.mark_codex_oauth_transient_failure("a");
        assert_eq!(summary(NOW), "剩余 5h ~36%");
        assert_eq!(summary(NOW + STALE_FOR_MS + 1), "剩余 —");
        let mut monthly = quota(85.0, NOW);
        monthly.tiers[0].name = crate::services::subscription::TIER_THIRTY_DAY.into();
        monthly.tiers[0].window_duration_seconds = Some(2_592_000);
        cache.put_codex_oauth("a".into(), monthly);
        assert_eq!(summary(NOW), "剩余 30d 15%");
        assert!(read(&cache, "a", NOW).seven_day.is_none());
        cache.invalidate_codex_oauth("a");
        assert_eq!(summary(NOW), "剩余 —");
    }

    #[test]
    fn menu_and_ring_share_long_interval_validity() {
        let cache = UsageCache::new();
        let mut good = quota(64.0, NOW);
        good.tiers[0].resets_at = None;
        cache.put_codex_oauth("a".into(), good);
        let entry = cache.codex_oauth_entry("a");
        let now = NOW + STALE_FOR_MS + 1;
        assert_eq!(
            remaining_menu_text(entry.as_ref(), "zh", now, 3600),
            "剩余 5h 36%"
        );
        assert_eq!(
            project_with_interval(entry.as_ref(), None, now, 3600).status,
            TrayQuotaStatus::Ready
        );
        assert_eq!(remaining_menu_text(entry.as_ref(), "zh", now, 60), "剩余 —");
    }

    #[test]
    fn account_projection_never_uses_default_native_or_other_account_values() {
        let cache = UsageCache::new();
        cache.put_codex_oauth("a".into(), quota(25.0, NOW));
        cache.put_codex_oauth("b".into(), quota(90.0, NOW));
        cache.put_subscription(AppType::Codex, quota(0.0, NOW));
        cache.put_native_codex(
            "native-provider".into(),
            "identity-a".into(),
            quota(5.0, NOW),
        );
        assert_eq!(read(&cache, "a", NOW).five_hour.unwrap().remaining, 75.0);
        assert_eq!(read(&cache, "b", NOW).five_hour.unwrap().remaining, 10.0);
        assert!(read(&cache, "missing", NOW).five_hour.is_none());
        assert!(cache
            .native_codex_entry("other-provider", "identity-a")
            .is_none());
        assert!(cache
            .native_codex_entry("native-provider", "identity-b")
            .is_none());
        cache.put_native_codex(
            "native-provider".into(),
            "identity-b".into(),
            quota(99.0, NOW),
        );
        assert!(cache
            .native_codex_entry("native-provider", "identity-a")
            .is_none());
        assert_eq!(
            cache
                .native_codex_entry("native-provider", "identity-b")
                .unwrap()
                .last_good
                .unwrap()
                .tiers[0]
                .utilization,
            99.0
        );
    }

    #[test]
    fn transient_failure_preserves_values_and_success_time_only_for_ten_minutes() {
        let cache = UsageCache::new();
        cache.put_codex_oauth("a".into(), quota(25.0, NOW));
        cache.mark_codex_oauth_transient_failure("a");
        let old = read(&cache, "a", NOW + 1);
        assert_eq!(old.status, TrayQuotaStatus::Stale);
        assert_eq!(old.updated_at, Some(NOW));
        assert_eq!(old.five_hour.unwrap().remaining, 75.0);
        assert!(read(&cache, "a", NOW + STALE_FOR_MS).five_hour.is_some());
        assert!(read(&cache, "a", NOW + STALE_FOR_MS + 1)
            .five_hour
            .is_none());
        cache.mark_codex_oauth_transient_failure("a");
        assert!(read(&cache, "a", NOW + STALE_FOR_MS + 2)
            .five_hour
            .is_none());
        cache.put_codex_oauth("a".into(), quota(50.0, NOW + 1));
        assert_eq!(read(&cache, "a", NOW + 1).status, TrayQuotaStatus::Ready);
    }

    #[test]
    fn deterministic_failure_discards_previous_values_even_after_transport_error() {
        for status in [
            CredentialStatus::Expired,
            CredentialStatus::NotFound,
            CredentialStatus::ParseError,
            CredentialStatus::Valid,
        ] {
            let cache = UsageCache::new();
            cache.put_codex_oauth("a".into(), quota(25.0, NOW));
            let expired = matches!(status, CredentialStatus::Expired);
            cache.put_codex_oauth(
                "a".into(),
                SubscriptionQuota::error("codex_oauth", status, "failed".into()),
            );
            cache.mark_codex_oauth_transient_failure("a");
            let view = read(&cache, "a", NOW + 1);
            assert!(view.five_hour.is_none());
            assert_eq!(
                view.status,
                if expired {
                    TrayQuotaStatus::Expired
                } else {
                    TrayQuotaStatus::Unavailable
                }
            );
        }
    }

    #[test]
    fn percent_boundaries_are_real_values_and_invalid_values_are_unknown() {
        let cache = UsageCache::new();
        for (used, remaining) in [(0.0, 100.0), (100.0, 0.0)] {
            cache.put_codex_oauth("a".into(), quota(used, NOW));
            assert_eq!(
                read(&cache, "a", NOW).five_hour.unwrap().remaining,
                remaining
            );
        }
        for used in [-0.01, 100.01, f64::NAN, f64::INFINITY] {
            cache.put_codex_oauth("a".into(), quota(used, NOW));
            assert!(read(&cache, "a", NOW).five_hour.is_none());
        }
    }

    #[test]
    fn exact_window_name_and_duration_are_required() {
        let cache = UsageCache::new();
        for (name, duration) in [
            ("seven_day_sonnet", Some(604_800)),
            (TIER_FIVE_HOUR, Some(18_001)),
            ("5_hour", Some(18_000)),
            ("30_day", Some(2_592_000)),
        ] {
            let mut data = quota(25.0, NOW);
            data.tiers[0].name = name.into();
            data.tiers[0].window_duration_seconds = duration;
            cache.put_codex_oauth("a".into(), data);
            let view = read(&cache, "a", NOW);
            assert!(view.five_hour.is_none());
            assert!(view.seven_day.is_none());
        }
        let mut data = quota(25.0, NOW);
        data.tiers[0].name = TIER_SEVEN_DAY.into();
        data.tiers[0].window_duration_seconds = Some(604_800);
        cache.put_codex_oauth("a".into(), data);
        assert_eq!(read(&cache, "a", NOW).seven_day.unwrap().remaining, 75.0);
    }

    #[test]
    fn reset_crossing_and_old_timestamp_never_invent_a_fresh_quota() {
        let cache = UsageCache::new();
        cache.put_codex_oauth("a".into(), quota(100.0, NOW));
        let crossed = read(&cache, "a", NOW + 60_000);
        assert_eq!(crossed.status, TrayQuotaStatus::Stale);
        assert_eq!(crossed.five_hour.unwrap().remaining, 0.0);
        assert_eq!(crossed.updated_at, Some(NOW));
        assert_eq!(
            read(&cache, "a", NOW + FRESH_FOR_MS + 1).status,
            TrayQuotaStatus::Stale
        );
        let mut future = quota(25.0, NOW + 1);
        cache.put_codex_oauth("a".into(), future.clone());
        assert!(read(&cache, "a", NOW).five_hour.is_none());
        future.queried_at = None;
        cache.put_codex_oauth("a".into(), future);
        assert!(read(&cache, "a", NOW).five_hour.is_none());
    }
}
