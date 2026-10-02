//! Codex OAuth Tauri Commands
//!
//! 提供 OpenAI ChatGPT Plus/Pro OAuth 认证相关的 Tauri 命令。
//!
//! 大部分认证命令通过通用 `auth_*` 命令（参见 `commands::auth`）暴露给前端，
//! 此处定义 State wrapper 以及 Codex OAuth 专属的订阅额度和模型列表查询命令。

use crate::auth::codex_oauth::{CodexOAuthError, CodexOAuthManager};
use crate::services::model_fetch::FetchedModel;
use crate::services::subscription::{query_codex_quota, CredentialStatus, SubscriptionQuota};
use std::sync::Arc;
use tauri::State;

/// Codex OAuth 认证状态
///
/// `CodexOAuthManager` 内部已使用细粒度锁且所有方法均为 `&self`，因此这里
/// 直接持有 `Arc`，不再包一层 `RwLock`——避免任一命令持有粗粒度锁跨网络刷新
/// 时阻塞其他命令（切换 / 认证中心操作 / token 读取）。
pub struct CodexOAuthState(pub Arc<CodexOAuthManager>);

/// 查询 Codex OAuth (ChatGPT Plus/Pro) 订阅额度
///
/// - `account_id` 未指定时回退到 `CodexOAuthManager` 的默认账号
/// - 没有任何账号时返回 `not_found`，前端 `SubscriptionQuotaView` 会静默不渲染
/// - 复用 `services::subscription::query_codex_quota`，因此 wham/usage 端点协议
///   与 Codex CLI 路径完全一致
#[tauri::command(rename_all = "camelCase")]
pub async fn get_codex_oauth_quota(
    app: tauri::AppHandle,
    app_state: State<'_, crate::store::AppState>,
    account_id: Option<String>,
    state: State<'_, CodexOAuthState>,
) -> Result<SubscriptionQuota, String> {
    let manager = &state.0;

    // 解析最终使用的账号 ID：显式 > 默认账号 > 无账号 (not_found)
    let resolved = match account_id {
        Some(id) => Some(id.trim().to_string()),
        None => manager.default_account_id().await,
    };
    let Some(id) = resolved else {
        return Ok(SubscriptionQuota::not_found("codex_oauth"));
    };

    let generation = app_state.usage_cache.codex_oauth_generation(&id);
    let result = app_state
        .usage_cache
        .coalesced_quota(
            format!("managed-codex:{id}:{generation}"),
            query_codex_oauth_quota_for(manager, &id),
        )
        .await;
    // Cache by the resolved account, even if the default/binding changes while
    // the request is in flight. Transport errors retain the last good snapshot;
    // authentication/HTTP failures replace it so the tray hides invalid quotas.
    if !app_state
        .usage_cache
        .finish_codex_oauth_query(&id, generation, &result)
    {
        return Err("Codex account changed during quota refresh".into());
    }
    crate::tray::schedule_tray_refresh(&app);
    crate::tray::update_tray_display(&app);
    result
}

async fn query_codex_oauth_quota_for(
    manager: &CodexOAuthManager,
    id: &str,
) -> Result<SubscriptionQuota, String> {
    // 获取（必要时自动刷新）access_token
    let token = match manager.get_valid_token_for_account(id).await {
        Ok(t) => t,
        Err(error) => return codex_oauth_quota_token_failure(error),
    };
    let chatgpt_account_id = manager
        .chatgpt_account_id_for_account(id)
        .await
        .map_err(|e| e.to_string())?;

    // 瞬时传输失败以 Err 传播（前端 reject → retry + 保留上次成功值）。
    query_codex_quota(
        &token,
        Some(&chatgpt_account_id),
        "codex_oauth",
        "Codex OAuth access token expired or rejected. Please sign in again in Codex Switch.",
    )
    .await
}

/// Only an explicit authentication rejection establishes expired credentials.
/// Transport, disk, protocol and other refresh failures reject the query so the
/// caller can report a refresh error without replacing a good account snapshot.
fn codex_oauth_quota_token_failure(error: CodexOAuthError) -> Result<SubscriptionQuota, String> {
    match error {
        CodexOAuthError::RefreshTokenInvalid => Ok(SubscriptionQuota::error(
            "codex_oauth",
            CredentialStatus::Expired,
            "Codex OAuth refresh token expired or rejected. Please sign in again in Codex Switch."
                .into(),
        )),
        CodexOAuthError::AccountNotFound(_) => Ok(SubscriptionQuota::not_found("codex_oauth")),
        error => Err(format!("Codex OAuth quota refresh failed: {error}")),
    }
}

/// 获取 Codex OAuth (ChatGPT Plus/Pro) 可用模型列表
///
/// ChatGPT Codex 反代使用 `chatgpt.com/backend-api/codex/*`，不是 OpenAI 兼容
/// `/v1/models`。这里复用托管 OAuth 账号的 access_token，直接读取 Codex 后端
/// 暴露的模型列表端点。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_codex_oauth_models(
    account_id: Option<String>,
    state: State<'_, CodexOAuthState>,
) -> Result<Vec<FetchedModel>, String> {
    let manager = &state.0;
    let resolved = match account_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => Some(id.to_string()),
        None => manager.default_account_id().await,
    };
    let Some(id) = resolved else {
        return Err("No ChatGPT account available".to_string());
    };

    let token = manager
        .get_valid_token_for_account(&id)
        .await
        .map_err(|e| format!("Codex OAuth token unavailable: {e}"))?;
    let chatgpt_account_id = manager
        .chatgpt_account_id_for_account(&id)
        .await
        .map_err(|e| e.to_string())?;

    crate::services::codex_oauth_models::fetch_models_with_token(&token, &chatgpt_account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_token_failure_only_marks_expired_after_authentication_rejection() {
        let quota = codex_oauth_quota_token_failure(CodexOAuthError::RefreshTokenInvalid).unwrap();
        assert!(matches!(quota.credential_status, CredentialStatus::Expired));
        assert!(!quota.success);
        assert!(quota.tiers.is_empty());
        assert!(quota.credential_message.unwrap().contains("Codex Switch"));
        let missing =
            codex_oauth_quota_token_failure(CodexOAuthError::AccountNotFound("removed".into()))
                .unwrap();
        assert!(matches!(
            missing.credential_status,
            CredentialStatus::NotFound
        ));
        assert!(!missing.success);
    }

    #[test]
    fn quota_token_network_io_protocol_and_unknown_failures_reject_refresh() {
        for error in [
            CodexOAuthError::NetworkError("temporary transport failure".into()),
            CodexOAuthError::IoError("temporary storage failure".into()),
            CodexOAuthError::ParseError("unexpected OAuth response".into()),
            CodexOAuthError::TokenFetchFailed("Refresh failed: 503".into()),
            CodexOAuthError::AccountUnavailable("live identity mismatch".into()),
        ] {
            let result = codex_oauth_quota_token_failure(error);
            assert!(result
                .unwrap_err()
                .starts_with("Codex OAuth quota refresh failed:"));
        }
    }

    #[tokio::test]
    async fn quota_query_for_missing_account_returns_missing_without_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let manager = CodexOAuthManager::new(temp.path().to_path_buf());
        let quota = query_codex_oauth_quota_for(&manager, "removed-account")
            .await
            .unwrap();
        assert!(matches!(
            quota.credential_status,
            CredentialStatus::NotFound
        ));
        assert!(!quota.success);
        assert!(quota.tiers.is_empty());
    }
}
