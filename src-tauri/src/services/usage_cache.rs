//! 托盘展示用的用量缓存（进程内、写穿式）。
//!
//! 各 usage 查询命令成功时写入；系统托盘构建菜单时读取。不持久化，
//! 进程重启即空，由下一次自动查询或托盘悬停触发的刷新重新填充。

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use crate::app_config::AppType;
use crate::provider::UsageResult;
use crate::services::subscription::{CredentialStatus, SubscriptionQuota};

pub(crate) const QUOTA_KEEP_LAST_GOOD_MS: i64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaSnapshotStatus {
    Ready,
    Stale,
    Unavailable,
    Expired,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaRefreshState {
    pub status: QuotaSnapshotStatus,
    pub refresh_failed: bool,
    pub error: Option<String>,
    pub fresh_until: Option<i64>,
    pub valid_until: Option<i64>,
    pub generation: u64,
    pub attempted_at: Option<i64>,
}

/// The same projection is returned to the webview and rendered by the tray.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuotaSnapshot {
    #[serde(flatten)]
    pub quota: SubscriptionQuota,
    pub refresh_state: QuotaRefreshState,
}

/// Last successful data and the outcome of the most recent attempt are separate:
/// a transport failure never changes the timestamp of the successful data.
#[derive(Clone, Default)]
pub(crate) struct QuotaCacheEntry {
    pub(crate) latest: Option<SubscriptionQuota>,
    pub(crate) last_good: Option<SubscriptionQuota>,
    pub(crate) transient_failure: bool,
    pub(crate) refresh_error: Option<String>,
    pub(crate) attempted_at: Option<i64>,
}

impl QuotaCacheEntry {
    fn put(&mut self, quota: SubscriptionQuota) {
        self.transient_failure = false;
        self.refresh_error = None;
        self.attempted_at = Some(chrono::Utc::now().timestamp_millis());
        // Deterministic failures (including expired/missing credentials) discard
        // the previous values rather than letting them leak into a stale ring.
        self.last_good = quota.success.then(|| quota.clone());
        self.latest = Some(quota);
    }

    fn fail(&mut self, error: Option<String>) {
        self.transient_failure = true;
        self.refresh_error = error;
        self.attempted_at = Some(chrono::Utc::now().timestamp_millis());
    }

    pub(crate) fn snapshot(
        &self,
        now: i64,
        interval_seconds: u32,
        generation: u64,
    ) -> CodexQuotaSnapshot {
        let fresh_for = 120_000.max(i64::from(interval_seconds) * 1000 + 30_000);
        let keep_for = QUOTA_KEEP_LAST_GOOD_MS.max(fresh_for);
        let latest = self.latest.as_ref();
        let expired =
            latest.is_some_and(|q| matches!(q.credential_status, CredentialStatus::Expired));
        let usable = latest
            .is_none_or(|q| q.success && matches!(q.credential_status, CredentialStatus::Valid));
        let good = self.last_good.as_ref().filter(|_| usable);
        let updated = good.and_then(|q| q.queried_at).filter(|at| *at <= now);
        let fresh_until = updated.map(|at| at.saturating_add(fresh_for));
        let valid_until = updated.map(|at| at.saturating_add(keep_for));
        let available = good.is_some() && valid_until.is_some_and(|at| now <= at);
        let crossed_reset = good.is_some_and(|q| {
            q.tiers.iter().any(|tier| {
                tier.resets_at.as_deref().is_some_and(|reset| {
                    chrono::DateTime::parse_from_rfc3339(reset)
                        .map(|at| at.timestamp_millis() <= now)
                        .unwrap_or(true)
                })
            })
        });
        let status = if expired {
            QuotaSnapshotStatus::Expired
        } else if !available {
            QuotaSnapshotStatus::Unavailable
        } else if self.transient_failure || crossed_reset || fresh_until.is_some_and(|at| now > at)
        {
            QuotaSnapshotStatus::Stale
        } else {
            QuotaSnapshotStatus::Ready
        };
        let quota = if available {
            good.unwrap().clone()
        } else if let Some(quota) = latest.filter(|q| !q.success) {
            quota.clone()
        } else {
            let mut quota = SubscriptionQuota::error(
                "codex_oauth",
                CredentialStatus::Valid,
                self.refresh_error
                    .clone()
                    .unwrap_or_else(|| "Quota unavailable".into()),
            );
            quota.queried_at = updated;
            quota
        };
        CodexQuotaSnapshot {
            quota,
            refresh_state: QuotaRefreshState {
                status,
                refresh_failed: self.transient_failure,
                error: self.refresh_error.clone(),
                fresh_until,
                valid_until,
                generation,
                attempted_at: self.attempted_at,
            },
        }
    }
}

type SharedQuotaResult = Option<(Instant, Result<SubscriptionQuota, String>)>;

#[derive(Default)]
pub struct UsageCache {
    subscription: RwLock<HashMap<AppType, QuotaCacheEntry>>,
    codex_oauth: RwLock<HashMap<String, QuotaCacheEntry>>,
    codex_oauth_generations: RwLock<HashMap<String, u64>>,
    native_codex: RwLock<HashMap<String, (String, QuotaCacheEntry)>>,
    quota_queries: RwLock<HashMap<String, Arc<tokio::sync::Mutex<SharedQuotaResult>>>>,
    script: RwLock<HashMap<(AppType, String), UsageResult>>,
}

impl UsageCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_subscription(&self, app_type: AppType, quota: SubscriptionQuota) {
        if let Ok(mut w) = self.subscription.write() {
            w.entry(app_type).or_default().put(quota);
        }
    }

    pub fn put_codex_oauth(&self, account_id: String, quota: SubscriptionQuota) {
        if let Ok(mut w) = self.codex_oauth.write() {
            w.entry(account_id).or_default().put(quota);
        }
    }

    /// Managed accounts must never share the CLI's app-wide subscription snapshot.
    pub fn with_codex_oauth<R>(
        &self,
        account_id: &str,
        f: impl FnOnce(&SubscriptionQuota) -> R,
    ) -> Option<R> {
        self.codex_oauth.read().ok().and_then(|r| {
            r.get(account_id)
                .and_then(|entry| entry.latest.as_ref().map(f))
        })
    }

    pub(crate) fn codex_oauth_entry(&self, account_id: &str) -> Option<QuotaCacheEntry> {
        self.codex_oauth.read().ok()?.get(account_id).cloned()
    }

    pub(crate) fn codex_oauth_generation(&self, account_id: &str) -> u64 {
        *self
            .codex_oauth_generations
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .entry(account_id.to_owned())
            .or_default()
    }

    /// Publish only if login/removal/restore has not invalidated this request.
    pub(crate) fn finish_codex_oauth_query(
        &self,
        account_id: &str,
        generation: u64,
        result: &Result<SubscriptionQuota, String>,
    ) -> bool {
        let generations = self
            .codex_oauth_generations
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if generations.get(account_id).copied().unwrap_or_default() != generation {
            return false;
        }
        let mut entries = self.codex_oauth.write().unwrap_or_else(|e| e.into_inner());
        let entry = entries.entry(account_id.to_owned()).or_default();
        match result {
            Ok(quota) => entry.put(quota.clone()),
            Err(error) => entry.fail(Some(error.clone())),
        }
        true
    }

    pub(crate) fn invalidate_codex_oauth(&self, account_id: &str) {
        let mut generations = self
            .codex_oauth_generations
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let generation = generations.entry(account_id.to_owned()).or_default();
        *generation = generation.wrapping_add(1);
        self.codex_oauth
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(account_id);
        // Generation is also in the query key, so detached in-flight waiters
        // cannot republish their result or be joined by the new login.
        let prefix = format!("managed-codex:{account_id}:");
        self.quota_queries
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| !key.starts_with(&prefix));
    }

    pub(crate) fn invalidate_all_codex_oauth(&self) {
        let mut generations = self
            .codex_oauth_generations
            .write()
            .unwrap_or_else(|e| e.into_inner());
        for generation in generations.values_mut() {
            *generation = generation.wrapping_add(1);
        }
        self.codex_oauth
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.quota_queries
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| !key.starts_with("managed-codex:"));
    }

    pub(crate) fn mark_codex_oauth_transient_failure(&self, account_id: &str) {
        if let Ok(mut entries) = self.codex_oauth.write() {
            entries
                .entry(account_id.to_string())
                .or_default()
                .fail(None);
        }
    }

    pub(crate) fn native_codex_entry(
        &self,
        provider_id: &str,
        scope: &str,
    ) -> Option<QuotaCacheEntry> {
        self.native_codex
            .read()
            .ok()?
            .get(provider_id)
            .filter(|(identity, _)| identity == scope)
            .map(|(_, entry)| entry.clone())
    }

    pub(crate) fn put_native_codex(
        &self,
        provider_id: String,
        scope: String,
        quota: SubscriptionQuota,
    ) {
        if let Ok(mut entries) = self.native_codex.write() {
            let entry = entries.entry(provider_id).or_default();
            if entry.0 != scope {
                *entry = (scope, QuotaCacheEntry::default());
            }
            entry.1.put(quota);
        }
    }

    pub(crate) fn invalidate_native_codex(&self, provider_id: &str) {
        if let Ok(mut entries) = self.native_codex.write() {
            entries.remove(provider_id);
        }
    }

    pub(crate) fn mark_subscription_transient_failure(&self, app_type: AppType) {
        if let Ok(mut entries) = self.subscription.write() {
            entries.entry(app_type).or_default().fail(None);
        }
    }

    pub(crate) fn mark_native_codex_transient_failure(
        &self,
        provider_id: &str,
        scope: &str,
        error: &str,
    ) {
        if let Ok(mut entries) = self.native_codex.write() {
            let entry = entries.entry(provider_id.to_string()).or_default();
            if entry.0 != scope {
                *entry = (scope.to_string(), QuotaCacheEntry::default());
            }
            entry.1.fail(Some(error.into()));
        }
    }

    /// Automatic readers share the configured freshness window, even when their
    /// timers are offset. Explicit refreshes (zero max age) join in-flight work,
    /// while a subsequent explicit refresh always starts a new request.
    /// Failures are shared too, avoiding retries from offset automatic readers.
    pub(crate) async fn quota_with_max_age(
        &self,
        key: String,
        max_age: Duration,
        query: impl std::future::Future<Output = Result<SubscriptionQuota, String>>,
    ) -> Result<SubscriptionQuota, String> {
        let requested_at = Instant::now();
        let slot = self
            .quota_queries
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone();
        let mut result = slot.lock().await;
        if let Some((finished, previous)) = result.as_ref() {
            if *finished >= requested_at || finished.elapsed() < max_age {
                return previous.clone();
            }
        }
        let fresh = query.await;
        *result = Some((Instant::now(), fresh.clone()));
        fresh
    }

    pub fn put_script(&self, app_type: AppType, provider_id: String, result: UsageResult) {
        if let Ok(mut w) = self.script.write() {
            w.insert((app_type, provider_id), result);
        }
    }

    /// 以借用形式暴露订阅快照，避免托盘每次重建时深拷贝整个 `SubscriptionQuota`。
    pub fn with_subscription<R>(
        &self,
        app_type: &AppType,
        f: impl FnOnce(&SubscriptionQuota) -> R,
    ) -> Option<R> {
        self.subscription.read().ok().and_then(|r| {
            r.get(app_type)
                .and_then(|entry| entry.latest.as_ref().map(f))
        })
    }

    /// 以借用形式暴露脚本型用量结果，同上。
    pub fn with_script<R>(
        &self,
        app_type: &AppType,
        provider_id: &str,
        f: impl FnOnce(&UsageResult) -> R,
    ) -> Option<R> {
        self.script
            .read()
            .ok()
            .and_then(|r| r.get(&(app_type.clone(), provider_id.to_string())).map(f))
    }

    pub fn invalidate_script(&self, app_type: &AppType, provider_id: &str) {
        // 热路径会对每个禁用脚本的 provider 在托盘重建时调用一次：先走读锁
        // `contains_key` 快速放行"本来就不在缓存里"的常见情况，避免无谓的写锁升级。
        let key = (app_type.clone(), provider_id.to_string());
        if !self.script.read().is_ok_and(|r| r.contains_key(&key)) {
            return;
        }
        if let Ok(mut w) = self.script.write() {
            w.remove(&key);
        }
    }

    pub fn invalidate_subscription(&self, app_type: &AppType) {
        if !self
            .subscription
            .read()
            .is_ok_and(|r| r.contains_key(app_type))
        {
            return;
        }
        if let Ok(mut w) = self.subscription.write() {
            w.remove(app_type);
        }
    }

    /// Drop all process-local usage snapshots after a database/provider restore.
    pub fn invalidate_all(&self) {
        self.invalidate_all_codex_oauth();
        if let Ok(mut subscriptions) = self.subscription.write() {
            subscriptions.clear();
        }
        if let Ok(mut scripts) = self.script.write() {
            scripts.clear();
        }
        if let Ok(mut native) = self.native_codex.write() {
            native.clear();
        }
        if let Ok(mut queries) = self.quota_queries.write() {
            queries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn offset_automatic_quota_readers_share_the_interval_and_manual_refresh_bypasses_it() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = UsageCache::new();
        let calls = AtomicUsize::new(0);
        let query = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(fake_quota())
        };
        cache
            .quota_with_max_age("a".into(), Duration::from_secs(60), query())
            .await
            .unwrap();
        let slot = cache
            .quota_queries
            .read()
            .unwrap()
            .get("a")
            .unwrap()
            .clone();
        slot.lock().await.as_mut().unwrap().0 = Instant::now() - Duration::from_secs(5);
        cache
            .quota_with_max_age("a".into(), Duration::from_secs(60), query())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache
            .quota_with_max_age("a".into(), Duration::ZERO, query())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        cache
            .quota_with_max_age("a".into(), Duration::ZERO, query())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        cache
            .quota_with_max_age("b".into(), Duration::from_secs(60), query())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn quota_projection_shares_failure_and_original_success_time_without_reviving_expired_credentials(
    ) {
        let cache = UsageCache::new();
        let generation = cache.codex_oauth_generation("a");
        let mut good = fake_quota();
        good.queried_at = Some(1000);
        cache.finish_codex_oauth_query("a", generation, &Ok(good));
        cache.finish_codex_oauth_query("a", generation, &Err("Network error".into()));
        let entry = cache.codex_oauth_entry("a").unwrap();
        let snapshot = entry.snapshot(2000, 60, generation);
        assert!(snapshot.quota.success);
        assert_eq!(snapshot.quota.queried_at, Some(1000));
        assert_eq!(snapshot.refresh_state.status, QuotaSnapshotStatus::Stale);
        assert!(snapshot.refresh_state.refresh_failed);
        assert_eq!(
            snapshot.refresh_state.error.as_deref(),
            Some("Network error")
        );
        assert!(!entry.snapshot(601001, 60, generation).quota.success);
        // A deliberately long interval does not invalidate a successful snapshot early.
        assert!(entry.snapshot(601001, 3600, generation).quota.success);
        cache.finish_codex_oauth_query(
            "a",
            generation,
            &Ok(SubscriptionQuota::error(
                "codex_oauth",
                CredentialStatus::Expired,
                "expired".into(),
            )),
        );
        cache.finish_codex_oauth_query("a", generation, &Err("Network error".into()));
        let snapshot = cache
            .codex_oauth_entry("a")
            .unwrap()
            .snapshot(2000, 60, generation);
        assert!(!snapshot.quota.success);
        assert_eq!(snapshot.refresh_state.status, QuotaSnapshotStatus::Expired);
    }
    use crate::services::subscription::CredentialStatus;

    fn fake_quota() -> SubscriptionQuota {
        SubscriptionQuota {
            tool: "claude".to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers: vec![],
            extra_usage: None,
            error: None,
            queried_at: Some(0),
        }
    }

    fn fake_result() -> UsageResult {
        UsageResult {
            success: true,
            data: None,
            error: None,
        }
    }

    #[test]
    fn login_removal_and_restore_reject_inflight_managed_quota() {
        let cache = UsageCache::new();
        let first = cache.codex_oauth_generation("a");
        let other = cache.codex_oauth_generation("b");
        let result = Ok(fake_quota());
        assert!(cache.finish_codex_oauth_query("a", first, &result));
        cache.invalidate_codex_oauth("a");
        assert!(!cache.finish_codex_oauth_query("a", first, &result));
        assert!(cache.codex_oauth_entry("a").is_none());
        assert!(cache.finish_codex_oauth_query("b", other, &result));
        let reauthenticated = cache.codex_oauth_generation("a");
        assert_ne!(first, reauthenticated);
        assert!(cache.finish_codex_oauth_query("a", reauthenticated, &result));
        cache.invalidate_all();
        assert!(!cache.finish_codex_oauth_query("a", reauthenticated, &result));
        assert!(!cache.finish_codex_oauth_query("b", other, &result));
        assert!(cache.codex_oauth_entry("a").is_none());
        assert!(cache.codex_oauth_entry("b").is_none());
    }

    #[test]
    fn subscription_round_trip() {
        let cache = UsageCache::new();
        assert!(cache
            .with_subscription(&AppType::Claude, |q| q.success)
            .is_none());
        cache.put_subscription(AppType::Claude, fake_quota());
        let got = cache
            .with_subscription(&AppType::Claude, |q| q.success)
            .unwrap();
        assert!(got);
        assert!(cache
            .with_subscription(&AppType::Codex, |q| q.success)
            .is_none());
    }

    #[test]
    fn script_round_trip_and_invalidate() {
        let cache = UsageCache::new();
        assert!(cache
            .with_script(&AppType::Codex, "pid", |r| r.success)
            .is_none());
        cache.put_script(AppType::Codex, "pid".to_string(), fake_result());
        assert!(cache
            .with_script(&AppType::Codex, "pid", |r| r.success)
            .is_some());
        cache.invalidate_script(&AppType::Codex, "pid");
        assert!(cache
            .with_script(&AppType::Codex, "pid", |r| r.success)
            .is_none());
    }

    #[test]
    fn script_keys_isolated_by_app_type() {
        let cache = UsageCache::new();
        cache.put_script(AppType::Claude, "same".to_string(), fake_result());
        assert!(cache
            .with_script(&AppType::Claude, "same", |r| r.success)
            .is_some());
        assert!(cache
            .with_script(&AppType::Codex, "same", |r| r.success)
            .is_none());
    }

    #[test]
    fn invalidate_all_clears_all_usage_snapshots() {
        let cache = UsageCache::new();
        cache.put_subscription(AppType::Claude, fake_quota());
        cache.put_codex_oauth("account-1".to_string(), fake_quota());
        cache.put_script(AppType::Codex, "provider".to_string(), fake_result());

        cache.invalidate_all();

        assert!(cache
            .with_subscription(&AppType::Claude, |quota| quota.success)
            .is_none());
        assert!(cache
            .with_script(&AppType::Codex, "provider", |usage| usage.success)
            .is_none());
        assert!(cache
            .with_codex_oauth("account-1", |quota| quota.success)
            .is_none());
    }
    #[tokio::test]
    async fn simultaneous_quota_requests_share_success_and_failure_per_account() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = UsageCache::new();
        let calls = AtomicUsize::new(0);
        let query = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(fake_quota())
        };
        let (a, b) = tokio::join!(
            cache.quota_with_max_age("managed:a".into(), Duration::ZERO, query()),
            cache.quota_with_max_age("managed:a".into(), Duration::ZERO, query()),
        );
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache
            .quota_with_max_age("managed:b".into(), Duration::ZERO, query())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let failing = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Err("temporary transport failure".into())
        };
        let (a, b) = tokio::join!(
            cache.quota_with_max_age("managed:failed".into(), Duration::ZERO, failing()),
            cache.quota_with_max_age("managed:failed".into(), Duration::ZERO, failing()),
        );
        assert_eq!(a.unwrap_err(), b.unwrap_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(cache
            .quota_with_max_age("managed:failed".into(), Duration::from_secs(60), failing())
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
