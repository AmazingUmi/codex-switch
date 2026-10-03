//! Independent account selection and one-way removal of legacy account providers.
use super::{codex_direct, CodexAccountSwitchResult, ProviderService};
use crate::app_config::AppType;
use crate::error::AppError;
use crate::mode::current::{codex_active_selection, codex_selection_target, CodexActiveSelection};
use crate::provider::Provider;
use crate::store::AppState;

fn has_api_configuration(provider: &Provider) -> bool {
    let text = provider
        .settings_config
        .get("config")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if crate::codex_config::extract_codex_api_key(provider.settings_config.get("auth"), Some(text))
        .is_some_and(|key| key != crate::live::project::codex::PROXY_TOKEN_PLACEHOLDER)
    {
        return true;
    }
    if ProviderService::managed_codex_oauth_account_id(provider).is_some()
        || provider
            .meta
            .as_ref()
            .is_some_and(|meta| meta.codex_account_managed == Some(true))
    {
        return false;
    }
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return false;
    };
    doc.get("openai_base_url").is_some()
        || doc
            .get("model_provider")
            .and_then(toml_edit::Item::as_str)
            .is_some_and(|id| id != "openai" && id != "codex-switch-official")
}

pub(crate) fn is_account_provider(provider: &Provider) -> bool {
    !has_api_configuration(provider)
        && (codex_direct::is_official(provider)
            || ProviderService::managed_codex_oauth_account_id(provider).is_some()
            || provider.meta.as_ref().is_some_and(|meta| {
                meta.codex_account_managed == Some(true)
                    || meta.provider_type.as_deref() == Some("codex_oauth")
            })
            || provider
                .settings_config
                .get("auth")
                .is_some_and(crate::codex_config::codex_auth_has_credential_login_material))
}

pub(crate) fn ensure_api_provider(provider: &Provider) -> Result<(), AppError> {
    if provider
        .meta
        .as_ref()
        .and_then(|meta| meta.usage_script.as_ref())
        .is_some_and(|script| script.template_type.as_deref() == Some("official_subscription"))
        || is_account_provider(provider)
        || provider.meta.as_ref().is_some_and(|meta| {
            meta.auth_binding.is_some()
                || meta.codex_account_managed == Some(true)
                || meta.provider_type.as_deref() == Some("codex_oauth")
        })
        || provider
            .settings_config
            .get("auth")
            .is_some_and(crate::codex_config::codex_auth_has_credential_login_material)
    {
        return Err(AppError::Message(
            "Subscription accounts must be added and activated independently of API providers"
                .into(),
        ));
    }
    Ok(())
}

pub(crate) fn switch(
    state: &AppState,
    account_id: &str,
) -> Result<CodexAccountSwitchResult, AppError> {
    let _guard = crate::mode::controller::lock_settled_blocking(state, &AppType::Codex).map_err(
        |error| {
            AppError::Message(format!(
                "codex_account_switch_uncertain: previous transaction could not settle: {error}"
            ))
        },
    )?;
    switch_locked(state, account_id)
}

pub(crate) fn switch_locked(
    state: &AppState,
    account_id: &str,
) -> Result<CodexAccountSwitchResult, AppError> {
    let account_id = account_id.trim();
    let account = tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts())
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| AppError::Message("Codex account no longer exists".into()))?;
    if account.reauth_required {
        return Err(AppError::Message(
            "This Codex account needs to sign in again before switching".into(),
        ));
    }
    let selection = codex_active_selection(&state.db)?;
    let provider = match &selection {
        Some(CodexActiveSelection::Provider { provider_id }) => {
            state.db.get_provider_by_id(provider_id, "codex")?
        }
        _ => None,
    };
    let owner = match &selection {
        Some(CodexActiveSelection::Account { account_id }) => {
            codex_direct::Owner::Account(account_id)
        }
        _ => provider
            .as_ref()
            .map_or(codex_direct::Owner::None, codex_direct::Owner::Provider),
    };
    let target = codex_direct::Target::Account(account_id);
    codex_direct::preflight_account_auth_store(&state.db, &owner, &target)?;
    let prepared = codex_direct::prepare(&state.codex_oauth_manager, &owner, &target)?;
    let planned = codex_direct::plan(&state.db, &owner, &target, &prepared)?;
    let pending = codex_selection_target(Some(CodexActiveSelection::Account {
        account_id: account_id.into(),
    }));
    let written = codex_direct::run(
        &state.db,
        crate::mode::state::op::SWITCH,
        planned,
        &prepared,
        pending,
    );
    let mut warnings = Vec::new();
    if let Err(error) = written {
        let uncertain = |detail: String| {
            AppError::Message(format!(
                "codex_account_switch_uncertain: {detail}. Original error: {error}"
            ))
        };
        let pending = crate::mode::state::pending(
            &crate::live::engine::DeviceStore::for_device(),
            "codex",
        )
        .map_err(|read| uncertain(format!("transaction status could not be read: {read}")))?;
        if pending.is_none() {
            return Err(error);
        }
        let outcome = crate::mode::operation::settle(&state.db, "codex")
            .map_err(|recovery| uncertain(format!("transaction recovery failed: {recovery}")))?;
        match outcome {
            Some(crate::mode::operation::RecoveryOutcome::RolledForward) => {
                let recovered = codex_active_selection(&state.db).map_err(|read| {
                    uncertain(format!("recovered selection could not be read: {read}"))
                })?;
                if recovered
                    != Some(CodexActiveSelection::Account {
                        account_id: account_id.into(),
                    })
                {
                    return Err(uncertain("recovery selected a different identity".into()));
                }
                warnings.push("codex_account_switch_recovered".into());
            }
            Some(crate::mode::operation::RecoveryOutcome::RolledForwardExcept { .. }) => {
                return Err(uncertain("Codex files changed during recovery".into()))
            }
            _ => return Err(error),
        }
    }
    Ok(CodexAccountSwitchResult {
        account_id: account_id.into(),
        warnings,
    })
}

pub(crate) fn clear_removed_selection(
    state: &AppState,
    removed: Option<&str>,
) -> Result<(), AppError> {
    if let Some(CodexActiveSelection::Account { account_id }) = codex_active_selection(&state.db)? {
        if removed.is_none_or(|id| id == account_id) {
            // The manager has already removed owned credentials. KeepNative preserves unrelated native logins.
            codex_direct::write_direct(
                &state.db,
                &state.codex_oauth_manager,
                "disconnect-account",
                codex_direct::Owner::None,
                None,
                codex_selection_target(None),
            )?;
        }
    }
    Ok(())
}

pub(crate) fn delete_provider(state: &AppState, id: &str) -> Result<(), AppError> {
    state.usage_cache.invalidate_script(&AppType::Codex, id);
    state.usage_cache.invalidate_subscription(&AppType::Codex);
    let _guard = crate::mode::controller::lock_settled_blocking(state, &AppType::Codex)?;
    if codex_active_selection(&state.db)?
        == Some(CodexActiveSelection::Provider {
            provider_id: id.into(),
        })
    {
        if let Some(provider) = state.db.get_provider_by_id(id, "codex")? {
            let mut pending = codex_selection_target(None);
            pending.extra.insert(
                "deletedProvider".into(),
                serde_json::Value::String(id.into()),
            );
            codex_direct::write_direct(
                &state.db,
                &state.codex_oauth_manager,
                "delete-provider",
                codex_direct::Owner::Provider(&provider),
                None,
                pending,
            )?;
        }
    }
    state.db.delete_provider("codex", id)?;
    state.usage_cache.invalidate_script(&AppType::Codex, id);
    state.usage_cache.invalidate_subscription(&AppType::Codex);
    Ok(())
}

/// Run before any startup imports. Repeating after sync also cleans restored legacy rows.
pub(crate) fn migrate_legacy(state: &AppState) -> Result<(), AppError> {
    let _guard = crate::mode::controller::lock_settled_blocking(state, &AppType::Codex)?;
    let local_state = crate::mode::state::load(&crate::live::engine::DeviceStore::for_device())?;
    let uncertain = local_state
        .apps
        .get("codex")
        .and_then(|app| app.extra.get("selectionUncertain"))
        .cloned();
    let migration_target = |selection| {
        let mut target = codex_selection_target(selection);
        target
            .extra
            .insert("accountsSeparated".into(), serde_json::Value::Bool(true));
        if let Some(uncertain) = &uncertain {
            target
                .extra
                .insert("selectionUncertain".into(), uncertain.clone());
        }
        target
    };
    let account_ids: std::collections::HashSet<String> =
        tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts())
            .into_iter()
            .map(|account| account.id)
            .collect();
    let current = codex_active_selection(&state.db)?;
    let mut selection = current.clone();
    let providers = state.db.get_all_providers("codex")?;
    for provider in providers.values() {
        let bound = ProviderService::managed_codex_oauth_account_id(provider);
        // Provider snapshots are stale copies, not authoritative account storage. In
        // particular, importing them would revive identities logged out before upgrade.
        let existing_account = bound.filter(|id| account_ids.contains(id));
        if is_account_provider(provider) {
            if current
                == Some(CodexActiveSelection::Provider {
                    provider_id: provider.id.clone(),
                })
            {
                selection =
                    existing_account.map(|account_id| CodexActiveSelection::Account { account_id });
                // Publish the independent pointer before deleting its old row; interruption is restart-safe.
                crate::mode::operation::AppWrite::begin(&state.db, "codex")?.run(
                    "migrate-account-selection",
                    &[],
                    migration_target(selection.clone()),
                )?;
            }
            state.db.delete_provider("codex", &provider.id)?;
        } else {
            let mut cleaned = provider.clone();
            if let Some(meta) = &mut cleaned.meta {
                meta.auth_binding = None;
                meta.codex_account_managed = None;
                if meta.provider_type.as_deref() == Some("codex_oauth") {
                    meta.provider_type = None;
                }
                if meta.usage_script.as_ref().is_some_and(|script| {
                    script.template_type.as_deref() == Some("official_subscription")
                }) {
                    meta.usage_script = None;
                }
            }
            if let Some(auth) = cleaned
                .settings_config
                .get_mut("auth")
                .and_then(serde_json::Value::as_object_mut)
            {
                auth.remove("tokens");
                auth.remove("last_refresh");
                auth.remove("auth_mode");
            }
            if cleaned.category.as_deref() == Some("official")
                && crate::codex_config::extract_codex_api_key(
                    cleaned.settings_config.get("auth"),
                    cleaned
                        .settings_config
                        .get("config")
                        .and_then(serde_json::Value::as_str),
                )
                .is_none()
            {
                cleaned.category = Some("custom".into());
            }
            state.db.save_provider("codex", &cleaned)?;
        }
    }
    if let Some(CodexActiveSelection::Account { account_id }) = &selection {
        if !account_ids.contains(account_id) {
            selection = None;
        }
    }
    crate::mode::operation::AppWrite::begin(&state.db, "codex")?.run(
        "migrate-account-selection",
        &[],
        migration_target(selection),
    )?;
    state
        .db
        .set_setting("codex_account_provider_separated", "true")?;
    Ok(())
}
