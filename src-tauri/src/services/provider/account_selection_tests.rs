// Independent account / API provider lifecycle. Every test uses isolated native files.
use crate::mode::current::{codex_active_selection, CodexActiveSelection};

fn seed_account(state: &AppState, id: &str) {
    tauri::async_runtime::block_on(
        state
            .codex_oauth_manager
            .add_test_account_with_user_identity(
                id,
                &format!("access-{id}"),
                &format!("user-{id}"),
            ),
    )
    .unwrap();
}

fn api_provider(id: &str) -> Provider {
    Provider::with_id(
        id.into(),
        id.into(),
        codex_settings("https://example.test/v1", &format!("key-{id}")),
        None,
    )
}

#[test]
#[serial]
fn account_selection_never_creates_or_reuses_provider_rows() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        seed_account(state, "b");
        for id in ["a", "b", "a"] {
            assert_eq!(
                ProviderService::switch_codex_account(state, id)
                    .unwrap()
                    .account_id,
                id
            );
            assert!(state.db.get_all_providers("codex").unwrap().is_empty());
            assert!(ProviderService::current(state, AppType::Codex)
                .unwrap()
                .is_empty());
            assert_eq!(
                codex_active_selection(&state.db).unwrap(),
                Some(CodexActiveSelection::Account {
                    account_id: id.into()
                })
            );
            let auth: Value = read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
            assert_eq!(auth["tokens"]["access_token"], format!("access-{id}"));
        }
    });
}

#[test]
#[serial]
fn account_selection_api_add_switch_and_active_delete_are_independent() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let account_auth = fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
        ProviderService::add(state, AppType::Codex, api_provider("api"), false).unwrap();
        assert_eq!(
            fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
            account_auth
        );
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "a".into()
            })
        );
        ProviderService::switch(state, AppType::Codex, "api").unwrap();
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Provider {
                provider_id: "api".into()
            })
        );
        assert!(!crate::codex_config::get_codex_auth_path().exists());
        ProviderService::delete(state, AppType::Codex, "api").unwrap();
        assert_eq!(codex_active_selection(&state.db).unwrap(), None);
        let config = fs::read_to_string(crate::codex_config::get_codex_config_path()).unwrap();
        assert!(!config.contains("key-api"));
        assert!(!config.contains("example.test"));
        assert!(!should_import_default_config_on_startup(state, &AppType::Codex).unwrap());
        codex_accounts::migrate_legacy(state).unwrap();
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        assert_eq!(codex_active_selection(&state.db).unwrap(), None);
        assert_eq!(
            tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts()).len(),
            1
        );
    });
}

#[test]
#[serial]
fn account_selection_removal_and_logout_disconnect_without_fallback() {
    for logout in [false, true] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            seed_account(state, "a");
            seed_account(state, "b");
            ProviderService::switch_codex_account(state, "a").unwrap();
            if logout {
                tauri::async_runtime::block_on(
                    crate::commands::logout_codex_oauth_with_switch_lock(state),
                )
                .unwrap();
            } else {
                tauri::async_runtime::block_on(
                    crate::commands::remove_codex_oauth_account_with_switch_lock(state, "a"),
                )
                .unwrap();
            }
            assert_eq!(codex_active_selection(&state.db).unwrap(), None);
            assert!(!crate::codex_config::get_codex_auth_path().exists());
            assert!(!crate::codex_config::get_codex_managed_oauth_live_auth_marker_path().exists());
            assert!(state.db.get_all_providers("codex").unwrap().is_empty());
            let restarted = AppState::new(state.db.clone());
            codex_accounts::migrate_legacy(&restarted).unwrap();
            assert_eq!(codex_active_selection(&state.db).unwrap(), None);
            assert_eq!(
                tauri::async_runtime::block_on(restarted.codex_oauth_manager.list_accounts()).len(),
                if logout { 0 } else { 1 }
            );
        });
    }
}

#[test]
#[serial]
fn account_selection_failure_preserves_credentials_and_selection() {
    for mode in ["keyring", "auto", "ephemeral", "unknown"] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            seed_account(state, "a");
            seed_account(state, "b");
            ProviderService::switch_codex_account(state, "a").unwrap();
            fs::write(
                crate::codex_config::get_codex_config_path(),
                format!("cli_auth_credentials_store = \"{mode}\"\n"),
            )
            .unwrap();
            let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
            assert!(ProviderService::switch_codex_account(state, "b").is_err());
            assert_eq!(
                crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
                before
            );
            assert_eq!(
                codex_active_selection(&state.db).unwrap(),
                Some(CodexActiveSelection::Account {
                    account_id: "a".into()
                })
            );
            assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        });
    }
}

#[test]
#[serial]
fn account_selection_recovers_interrupted_publication_without_provider() {
    for point in ["staged", "pending", "published:0", "target"] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            seed_account(state, "a");
            seed_account(state, "b");
            ProviderService::switch_codex_account(state, "a").unwrap();
            crate::mode::operation::failpoint::crash_at(Some(point));
            let result = ProviderService::switch_codex_account(state, "b");
            crate::mode::operation::failpoint::crash_at(None);
            let selected = if result.is_ok() { "b" } else { "a" };
            assert_eq!(
                codex_active_selection(&state.db).unwrap(),
                Some(CodexActiveSelection::Account {
                    account_id: selected.into()
                })
            );
            assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        });
    }
}

#[test]
#[serial]
fn account_selection_migration_keeps_accounts_and_real_api_keys_only() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        let legacy = managed_codex_provider("legacy", "a");
        state.db.save_provider("codex", &legacy).unwrap();
        state.db.set_current_provider("codex", "legacy").unwrap();
        crate::settings::set_current_provider(&AppType::Codex, Some("legacy")).unwrap();
        let mut api = api_provider("openai-key");
        api.category = Some("official".into());
        api.meta = legacy.meta.clone();
        state.db.save_provider("codex", &api).unwrap();
        codex_accounts::migrate_legacy(state).unwrap();
        codex_accounts::migrate_legacy(state).unwrap();
        let rows = state.db.get_all_providers("codex").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows["openai-key"].settings_config, api.settings_config);
        assert!(rows["openai-key"]
            .meta
            .as_ref()
            .unwrap()
            .auth_binding
            .is_none());
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "a".into()
            })
        );
        assert_eq!(
            tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts()).len(),
            1
        );
    });
}

#[test]
#[serial]
fn account_selection_migration_never_resurrects_logged_out_provider_snapshots() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let auth = json!({"tokens":{"account_id":"old-workspace","id_token":crate::codex_config::test_codex_id_token("old-user"),"access_token":"old-access","refresh_token":"old-refresh"}});
        // Simulate pre-upgrade logout: authoritative account store is empty, while
        // the former current Provider and its copied tokens remain in the database.
        for bound in [true, false] {
            let mut legacy = managed_codex_provider("legacy", "removed-account");
            if !bound {
                legacy.meta = None;
            }
            legacy.settings_config["auth"] = auth.clone();
            state.db.save_provider("codex", &legacy).unwrap();
            state.db.set_current_provider("codex", "legacy").unwrap();
            crate::settings::set_current_provider(&AppType::Codex, Some("legacy")).unwrap();
            codex_accounts::migrate_legacy(state).unwrap();
            assert!(
                tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts())
                    .is_empty()
            );
            assert!(state.db.get_all_providers("codex").unwrap().is_empty());
            assert_eq!(codex_active_selection(&state.db).unwrap(), None);
        }
        assert!(!crate::codex_config::get_codex_auth_path().exists());
    });
}

#[test]
#[serial]
fn account_selection_empty_startup_and_native_login_never_seed_provider() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        codex_accounts::migrate_legacy(state).unwrap();
        state.db.init_default_official_providers().unwrap();
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        assert!(!should_import_default_config_on_startup(state, &AppType::Codex).unwrap());
        let auth = json!({"tokens":{"account_id":"native","id_token":crate::codex_config::test_codex_id_token("native-user"),"access_token":"native-access","refresh_token":"native-refresh"}});
        write_json_file(&crate::codex_config::get_codex_auth_path(), &auth).unwrap();
        fs::write(crate::codex_config::get_codex_config_path(), "").unwrap();
        assert!(import_default_config(state, AppType::Codex).is_err());
        codex_accounts::migrate_legacy(state).unwrap();
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        assert_eq!(
            read_json_file::<Value>(&crate::codex_config::get_codex_auth_path()).unwrap(),
            auth
        );
    });
}

#[test]
#[serial]
fn account_selection_public_provider_paths_reject_oauth_bindings() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        let legacy = managed_codex_provider("legacy", "a");
        assert!(ProviderService::add(state, AppType::Codex, legacy.clone(), false).is_err());
        state.db.save_provider("codex", &legacy).unwrap();
        assert!(ProviderService::switch(state, AppType::Codex, "legacy").is_err());
        assert!(ProviderService::update(state, AppType::Codex, None, legacy).is_err());
        assert!(!crate::codex_config::get_codex_auth_path().exists());
    });
}

#[test]
#[serial]
fn account_selection_removal_preserves_unrelated_external_credentials() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let native = json!({"tokens":{"account_id":"other","id_token":crate::codex_config::test_codex_id_token("other-user"),"access_token":"other-access","refresh_token":"other-refresh"}});
        write_json_file(&crate::codex_config::get_codex_auth_path(), &native).unwrap();
        tauri::async_runtime::block_on(
            crate::commands::remove_codex_oauth_account_with_switch_lock(state, "a"),
        )
        .unwrap();
        assert_eq!(
            read_json_file::<Value>(&crate::codex_config::get_codex_auth_path()).unwrap(),
            native
        );
        assert_eq!(codex_active_selection(&state.db).unwrap(), None);
    });
}

#[test]
#[serial]
fn account_selection_official_api_delete_cleans_owned_key_and_preserves_external_key() {
    for external in [false, true] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            let mut provider = Provider::with_id(
                "openai".into(),
                "OpenAI API".into(),
                json!({"auth":{"OPENAI_API_KEY":"owned-key"},"config":""}),
                None,
            );
            provider.category = Some("official".into());
            ProviderService::add(state, AppType::Codex, provider, false).unwrap();
            ProviderService::switch(state, AppType::Codex, "openai").unwrap();
            if external {
                let other = Provider::with_id(
                    "other".into(),
                    "Other API".into(),
                    json!({"auth":{"OPENAI_API_KEY":"external-key"},"config":""}),
                    None,
                );
                state.db.save_provider("codex", &other).unwrap();
                write_json_file(
                    &crate::codex_config::get_codex_auth_path(),
                    &json!({"OPENAI_API_KEY":"external-key"}),
                )
                .unwrap();
            }
            ProviderService::delete(state, AppType::Codex, "openai").unwrap();
            assert_eq!(codex_active_selection(&state.db).unwrap(), None);
            if external {
                assert_eq!(
                    read_json_file::<Value>(&crate::codex_config::get_codex_auth_path()).unwrap()
                        ["OPENAI_API_KEY"],
                    "external-key"
                );
            } else {
                assert!(!crate::codex_config::get_codex_auth_path().exists());
            }
        });
    }
}

#[test]
#[serial]
fn account_selection_cli_rotation_is_adopted_before_api_switch_and_conflicts_reject() {
    for conflict in [false, true] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            seed_account(state, "a");
            ProviderService::switch_codex_account(state, "a").unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            tauri::async_runtime::block_on(
                state
                    .codex_oauth_manager
                    .test_set_token_updated_at_ms("a", now),
            );
            let mut auth: Value =
                read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
            auth["tokens"]["refresh_token"] = json!("cli-rotated-refresh");
            auth["last_refresh"] = json!(chrono::DateTime::from_timestamp_millis(if conflict {
                now
            } else {
                now + 10_000
            })
            .unwrap()
            .to_rfc3339());
            write_json_file(&crate::codex_config::get_codex_auth_path(), &auth).unwrap();
            ProviderService::add(state, AppType::Codex, api_provider("api"), false).unwrap();
            let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
            for _ in 0..2 {
                let result = ProviderService::switch(state, AppType::Codex, "api");
                if conflict {
                    assert!(result.is_err());
                    assert_eq!(
                        crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
                        before
                    );
                    assert_eq!(
                        codex_active_selection(&state.db).unwrap(),
                        Some(CodexActiveSelection::Account {
                            account_id: "a".into()
                        })
                    );
                } else {
                    result.unwrap();
                }
            }
            if !conflict {
                assert_eq!(
                    tauri::async_runtime::block_on(
                        state
                            .codex_oauth_manager
                            .test_refresh_token_for_account("a")
                    )
                    .as_deref(),
                    Some("cli-rotated-refresh")
                );
            }
        });
    }
}

#[test]
#[serial]
fn account_selection_removal_waits_for_switch_lock_and_storage_failure_is_atomic() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
        crate::mode::operation::failpoint::crash_at(Some("staged"));
        let failed = tauri::async_runtime::block_on(
            crate::commands::remove_codex_oauth_account_with_switch_lock(state, "a"),
        );
        crate::mode::operation::failpoint::crash_at(None);
        assert!(failed.is_err());
        assert_eq!(
            crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
            before
        );
        assert_eq!(
            tauri::async_runtime::block_on(state.codex_oauth_manager.list_accounts()).len(),
            1
        );
        let guard = tauri::async_runtime::block_on(state.switch_locks.lock_for_app("codex"));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                tx.send(tauri::async_runtime::block_on(
                    crate::commands::remove_codex_oauth_account_with_switch_lock(state, "a"),
                ))
                .unwrap();
            });
            assert!(rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err());
            drop(guard);
            rx.recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
        });
        assert_eq!(codex_active_selection(&state.db).unwrap(), None);
    });
}

#[test]
#[serial]
fn account_selection_reapply_and_sync_keep_independent_account() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let auth_before = fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
        fs::write(crate::codex_config::get_codex_config_path(), "# user preference\napproval_policy = \"on-request\"\n\n[mcp_servers.echo-server]\ncommand = \"echo\"\n").unwrap();
        let claude_json = crate::get_claude_mcp_path();
        fs::write(&claude_json, "{ not valid json").unwrap();
        for unified in [true, false] {
            crate::settings::update_settings(crate::settings::AppSettings {
                unify_codex_session_history: unified,
                ..Default::default()
            })
            .unwrap();
            assert!(reapply_current_codex_official_live(state).unwrap());
            let text = fs::read_to_string(crate::codex_config::get_codex_config_path()).unwrap();
            let config: toml::Value = toml::from_str(&text).unwrap();
            if unified {
                assert_eq!(config["model_provider"].as_str(), Some("custom"));
                assert_eq!(
                    config["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
                    Some(true)
                );
            } else {
                assert!(config.get("model_provider").is_none());
            }
            assert!(text.contains("# user preference"));
            assert_eq!(config["approval_policy"].as_str(), Some("on-request"));
            assert_eq!(
                config["mcp_servers"]["echo-server"]["command"].as_str(),
                Some("echo")
            );
        }
        assert!(live::sync_current_provider_for_app(state, &AppType::Codex)
            .unwrap()
            .is_some());
        assert_eq!(
            fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
            auth_before
        );
        assert_eq!(fs::read_to_string(claude_json).unwrap(), "{ not valid json");
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "a".into()
            })
        );
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
    });
}

#[test]
#[serial]
fn account_selection_unreadable_journal_reports_uncertainty() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        seed_account(state, "b");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let state_path = crate::live::engine::DeviceStore::for_device().state_path();
        let journal = Arc::new(Mutex::new(None));
        let saved = journal.clone();
        let blocked = state_path.clone();
        crate::mode::operation::failpoint::on_before_publish(Some(Box::new(move |index, _| {
            if index == 0 {
                *saved.lock().unwrap() = Some(fs::read(&blocked).unwrap());
                fs::remove_file(&blocked).unwrap();
                fs::create_dir(&blocked).unwrap();
            }
        })));
        let result = ProviderService::switch_codex_account(state, "b");
        crate::mode::operation::failpoint::on_before_publish(None);
        assert!(result
            .unwrap_err()
            .to_string()
            .starts_with("codex_account_switch_uncertain:"));
        fs::remove_dir(&state_path).unwrap();
        fs::write(state_path, journal.lock().unwrap().take().unwrap()).unwrap();
        crate::mode::operation::settle(&state.db, "codex").unwrap();
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "a".into()
            })
        );
        let auth: Value = read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
        assert_eq!(auth["tokens"]["access_token"], "access-a");
        assert_eq!(
            ProviderService::switch_codex_account(state, "b")
                .unwrap()
                .account_id,
            "b"
        );
    });
}

#[test]
#[serial]
fn account_selection_uncertain_recovery_is_reported_and_remains_recoverable() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        seed_account(state, "b");
        ProviderService::switch_codex_account(state, "a").unwrap();
        let replaced = Arc::new(Mutex::new(None));
        let replaced_hook = replaced.clone();
        crate::mode::operation::failpoint::on_before_publish(Some(Box::new(move |index, path| {
            if index == 1 {
                let old = fs::read(path).ok();
                if path.is_file() {
                    fs::remove_file(path).unwrap();
                }
                fs::create_dir(path).unwrap();
                *replaced_hook.lock().unwrap() = Some((path.to_path_buf(), old));
            }
        })));
        let result = ProviderService::switch_codex_account(state, "b");
        crate::mode::operation::failpoint::on_before_publish(None);
        assert!(result
            .unwrap_err()
            .to_string()
            .starts_with("codex_account_switch_uncertain:"));
        assert!(crate::mode::operation::has_pending("codex"));
        assert!(state.db.get_all_providers("codex").unwrap().is_empty());
        let (path, old) = replaced.lock().unwrap().take().unwrap();
        fs::remove_dir(&path).unwrap();
        if let Some(old) = old {
            fs::write(&path, old).unwrap();
        }
        crate::mode::operation::settle(&state.db, "codex").unwrap();
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "b".into()
            })
        );
        assert_eq!(
            read_json_file::<Value>(&crate::codex_config::get_codex_auth_path()).unwrap()["tokens"]
                ["access_token"],
            "access-b"
        );
    });
}

#[test]
#[serial]
fn account_selection_corrupt_store_cannot_relinquish_live_credential_ownership() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        ProviderService::switch_codex_account(state, "a").unwrap();
        assert!(crate::codex_config::codex_managed_oauth_live_auth_marker_exists());
        ProviderService::add(state, AppType::Codex, api_provider("api"), false).unwrap();
        fs::write(
            crate::config::get_app_config_dir().join("codex_oauth_auth.json"),
            "{broken",
        )
        .unwrap();
        let restarted = AppState::new(state.db.clone());
        let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
        assert!(ProviderService::switch(&restarted, AppType::Codex, "api").is_err());
        assert_eq!(
            crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
            before
        );
        assert_eq!(
            codex_active_selection(&state.db).unwrap(),
            Some(CodexActiveSelection::Account {
                account_id: "a".into()
            })
        );
    });
}

#[test]
#[serial]
fn account_selection_removal_publication_recovery_preserves_other_accounts() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        seed_account(state, "a");
        seed_account(state, "b");
        ProviderService::switch_codex_account(state, "a").unwrap();
        crate::mode::operation::failpoint::crash_at(Some("published:0"));
        let result = tauri::async_runtime::block_on(
            crate::commands::remove_codex_oauth_account_with_switch_lock(state, "a"),
        );
        crate::mode::operation::failpoint::crash_at(None);
        result.unwrap();
        assert_eq!(codex_active_selection(&state.db).unwrap(), None);
        assert!(!crate::codex_config::get_codex_auth_path().exists());
        let restarted = AppState::new(state.db.clone());
        let accounts =
            tauri::async_runtime::block_on(restarted.codex_oauth_manager.list_accounts());
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "b");
    });
}
