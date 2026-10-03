// Account deletion publishes credential storage, owned native files and selection together.
impl CodexOAuthManager {
    pub(crate) async fn remove_account_with_db(
        &self,
        db: &crate::database::Database,
        id: &str,
    ) -> Result<(), CodexOAuthError> {
        self.remove_accounts_transaction(db, Some(id)).await
    }

    pub(crate) async fn clear_auth_with_db(
        &self,
        db: &crate::database::Database,
    ) -> Result<(), CodexOAuthError> {
        self.remove_accounts_transaction(db, None).await
    }

    async fn remove_accounts_transaction(
        &self,
        db: &crate::database::Database,
        id: Option<&str>,
    ) -> Result<(), CodexOAuthError> {
        use crate::live::engine::{digest, read_current, LiveFile};
        use crate::live::patch::{Guarded, WholeFile};
        use crate::mode::current::{
            codex_active_selection, codex_selection_target, CodexActiveSelection,
        };
        use crate::mode::operation::{AppWrite, FileChange, RecoveryOutcome};
        use crate::services::provider::codex_direct;
        let as_error = |error: crate::error::AppError| CodexOAuthError::IoError(error.to_string());
        let _lifecycle = self.lifecycle_lock.write().await;
        let _persist = self.storage_lock.lock().await;
        let accounts = self.accounts.read().await.clone();
        if id.is_some_and(|id| !accounts.contains_key(id)) {
            return Err(CodexOAuthError::AccountNotFound(id.unwrap().into()));
        }
        let removed: Vec<_> = accounts
            .values()
            .filter(|account| id.is_none_or(|id| id == account.account_id))
            .cloned()
            .collect();
        let mut retained = accounts.clone();
        retained.retain(|key, _| id.is_some_and(|id| id != key));
        let old_default = self.default_account_id.read().await.clone();
        let mut default = old_default
            .filter(|id| retained.contains_key(id))
            .or_else(|| Self::fallback_default_account_id(&retained));
        let store = CodexOAuthStore {
            version: 2,
            accounts: retained.clone(),
            default_account_id: default.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&store)
            .map_err(|error| CodexOAuthError::ParseError(error.to_string()))?;
        let mut publication_error = None;
        {
            let write = AppWrite::begin(db, "codex").map_err(as_error)?;
            let mut patches: Vec<(std::path::PathBuf, Guarded)> = Vec::new();
            let store_pre = read_current(&self.storage_path)
                .map_err(|error| CodexOAuthError::IoError(error.to_string()))?;
            patches.push((
                self.storage_path.clone(),
                Guarded {
                    expected_pre: digest(store_pre.as_deref()),
                    then: if id.is_none() {
                        WholeFile::Delete
                    } else {
                        WholeFile::Write(bytes)
                    },
                },
            ));

            // Workspace and stable user identity are both required; a user's unrelated CLI login is untouched.
            let owns = |auth: &serde_json::Value| {
                removed.iter().any(|account| {
                    let user = account
                        .id_token
                        .as_deref()
                        .and_then(crate::codex_config::extract_codex_id_token_user_identity);
                    let live_user = crate::codex_config::extract_codex_auth_user_identity(auth);
                    user.is_some()
                        && user == live_user
                        && auth
                            .pointer("/tokens/account_id")
                            .and_then(serde_json::Value::as_str)
                            == account.chatgpt_account_id.as_deref()
                })
            };
            let auth_path = crate::codex_config::get_codex_auth_path();
            let auth_pre = read_current(&auth_path)
                .map_err(|error| CodexOAuthError::IoError(error.to_string()))?;
            if let Some(pre) = &auth_pre {
                let auth: serde_json::Value = serde_json::from_slice(pre)
                    .map_err(|error| CodexOAuthError::ParseError(error.to_string()))?;
                if owns(&auth) {
                    patches.push((
                        auth_path,
                        Guarded {
                            expected_pre: digest(Some(pre)),
                            then: WholeFile::Delete,
                        },
                    ));
                }
            }
            let marker_path = crate::codex_config::get_codex_managed_oauth_live_auth_marker_path();
            if let Some(pre) = read_current(&marker_path)
                .map_err(|error| CodexOAuthError::IoError(error.to_string()))?
            {
                let marker: serde_json::Value = serde_json::from_slice(&pre).unwrap_or_default();
                if removed.iter().any(|account| {
                    marker.get("account_id").and_then(serde_json::Value::as_str)
                        == Some(account.account_id.as_str())
                }) {
                    patches.push((
                        marker_path,
                        Guarded {
                            expected_pre: digest(Some(&pre)),
                            then: WholeFile::Delete,
                        },
                    ));
                }
            }
            let stash_path = write.store.file("codex-login-stash.json");
            if let Some(pre) = read_current(&stash_path)
                .map_err(|error| CodexOAuthError::IoError(error.to_string()))?
            {
                let mut stash: serde_json::Value = serde_json::from_slice(&pre)
                    .map_err(|error| CodexOAuthError::ParseError(error.to_string()))?;
                if let Some(logins) = stash
                    .get_mut("logins")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    logins.retain(|_, auth| !owns(auth));
                }
                if stash
                    .get("last")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|last| {
                        stash
                            .get("logins")
                            .and_then(|logins| logins.get(last))
                            .is_none()
                    })
                {
                    stash["last"] = serde_json::Value::Null;
                }
                let bytes = serde_json::to_vec_pretty(&stash)
                    .map_err(|error| CodexOAuthError::ParseError(error.to_string()))?;
                patches.push((
                    stash_path,
                    Guarded {
                        expected_pre: digest(Some(&pre)),
                        then: WholeFile::Write(bytes),
                    },
                ));
            }
            let selection = codex_active_selection(db).map_err(as_error)?;
            let disconnect = matches!(&selection, Some(CodexActiveSelection::Account {account_id}) if id.is_none_or(|id| id == account_id));
            let prepared = codex_direct::Prepared::default();
            let planned = if disconnect {
                Some(
                    codex_direct::plan(
                        db,
                        &codex_direct::Owner::None,
                        &codex_direct::Target::Direct(None),
                        &prepared,
                    )
                    .map_err(as_error)?,
                )
            } else {
                None
            };
            let mut changes: Vec<_> = patches
                .iter()
                .map(|(path, patch)| FileChange {
                    file: LiveFile::private(path),
                    patch: patch as &dyn crate::live::patch::LivePatch,
                })
                .collect();
            if let Some(planned) = &planned {
                changes.push(FileChange {
                    file: LiveFile::private(crate::codex_config::get_codex_config_path()),
                    patch: planned.config(),
                });
            }
            let target = if disconnect {
                codex_selection_target(None)
            } else {
                crate::mode::state::PendingTarget::default()
            };
            let result = write.run("remove-account", &changes, target);
            drop(write);
            if let Err(error) = result {
                if !matches!(
                    crate::mode::operation::settle(db, "codex"),
                    Ok(Some(RecoveryOutcome::RolledForward))
                ) {
                    // The store is published first. If recovery is blocked after publication,
                    // do not retain usable in-memory credentials that the disk already removed.
                    let persisted = read_current(&self.storage_path)
                        .map_err(|error| CodexOAuthError::IoError(error.to_string()))?;
                    if persisted == store_pre {
                        return Err(as_error(error));
                    }
                    let actual = persisted
                        .as_deref()
                        .map(serde_json::from_slice::<CodexOAuthStore>)
                        .transpose()
                        .map_err(|error| CodexOAuthError::ParseError(error.to_string()))?
                        .unwrap_or_default();
                    retained = actual.accounts;
                    default = actual.default_account_id;
                    publication_error = Some(as_error(error));
                }
            }
        }
        *self.accounts.write().await = retained;
        *self.default_account_id.write().await = default;
        self.access_tokens
            .write()
            .await
            .retain(|key, _| id.is_some_and(|id| id != key));
        self.refresh_locks
            .write()
            .await
            .retain(|key, _| id.is_some_and(|id| id != key));
        self.target_login_generations
            .write()
            .await
            .retain(|key, _| id.is_some_and(|id| id != key));
        // All pending logins started before explicit removal are invalidated, so they cannot resurrect credentials.
        self.login_epoch.fetch_add(1, Ordering::AcqRel);
        self.pending_device_codes.write().await.clear();
        match publication_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
