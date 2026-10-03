// Included by provider::tests so the native test-home and account fixtures are shared.

#[test]
#[serial]
fn missing_codex_account_preserves_native_login_but_corrupt_store_blocks_recovery() {
    for corrupt in [false, true] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            crate::settings::update_settings(crate::settings::AppSettings {
                preserve_codex_official_auth_on_switch: true,
                ..Default::default()
            })
            .unwrap();
            let runtime = tauri::async_runtime::handle();
            runtime
                .block_on(
                    state
                        .codex_oauth_manager
                        .add_test_account_with_user_identity("old", "access", "user"),
                )
                .unwrap();
            let current = managed_codex_provider("current", "old");
            state.db.save_provider("codex", &current).unwrap();
            ProviderService::switch(state, AppType::Codex, "current").unwrap();
            let mut auth: Value =
                read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
            runtime
                .block_on(
                    crate::commands::remove_codex_oauth_account_with_switch_lock(state, "old"),
                )
                .unwrap();

            // A stale app marker cannot claim a later native login of the same user.
            auth["tokens"]["refresh_token"] = json!("native-rotated-token");
            write_json_file(&crate::codex_config::get_codex_auth_path(), &auth).unwrap();
            crate::codex_config::record_codex_managed_oauth_live_auth(&auth, "old").unwrap();
            if corrupt {
                fs::write(
                    crate::config::get_app_config_dir().join("codex_oauth_auth.json"),
                    "{broken",
                )
                .unwrap();
            }
            let restarted = AppState::new(state.db.clone());
            let mut settings = codex_settings("https://example.test/v1", "sk-target");
            settings["config"] = json!(settings["config"]
                .as_str()
                .unwrap()
                .replace("wire_api = \"chat\"", "wire_api = \"responses\""));
            let target =
                Provider::with_id("target".into(), "Native Responses".into(), settings, None);
            state.db.save_provider("codex", &target).unwrap();
            let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
            let result = ProviderService::switch(&restarted, AppType::Codex, "target");
            if corrupt {
                assert!(
                    result.is_err(),
                    "a corrupt account store cannot relinquish credential ownership"
                );
                assert_eq!(
                    crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
                    before
                );
                assert_eq!(
                    crate::mode::current::provider_for(
                        &state.db,
                        &AppType::Codex,
                        crate::mode::current::Purpose::InUse,
                    )
                    .unwrap()
                    .as_deref(),
                    Some("current")
                );
            } else {
                result.unwrap();
                assert!(
                    !crate::codex_config::codex_managed_oauth_live_auth_marker_exists(),
                    "a missing account relinquishes ownership of the native login"
                );
                assert_eq!(
                    crate::mode::current::provider_for(
                        &state.db,
                        &AppType::Codex,
                        crate::mode::current::Purpose::InUse,
                    )
                    .unwrap()
                    .as_deref(),
                    Some("target")
                );
            }
            assert_eq!(
                read_json_file::<Value>(&crate::codex_config::get_codex_auth_path()).unwrap(),
                auth,
                "neither path may overwrite the later CLI login or its refresh token"
            );
        });
    }
}

#[test]
#[serial]
fn deleted_codex_account_can_rebind_or_switch_directly_after_restart() {
    for rebind in [true, false] {
        with_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            let runtime = tauri::async_runtime::handle();
            let token = crate::codex_config::test_codex_id_token("same-user");
            runtime
                .block_on(
                    state
                        .codex_oauth_manager
                        .add_test_account_with_workspace_and_access_token(
                            "old-local-id",
                            "workspace",
                            "old-access",
                            Some(&token),
                        ),
                )
                .unwrap();
            let current = managed_codex_provider("current", "old-local-id");
            state.db.save_provider("codex", &current).unwrap();
            ProviderService::switch(state, AppType::Codex, &current.id).unwrap();
            runtime
                .block_on(
                    crate::commands::remove_codex_oauth_account_with_switch_lock(
                        state,
                        "old-local-id",
                    ),
                )
                .unwrap();
            assert!(!crate::codex_config::get_codex_auth_path().exists());
            assert!(!crate::codex_config::codex_managed_oauth_live_auth_marker_exists());

            let restarted = AppState::new(state.db.clone());
            let state = &restarted;
            // A fresh login gets a fresh local ID, even for the same user/workspace.
            runtime
                .block_on(
                    state
                        .codex_oauth_manager
                        .add_test_account_with_workspace_and_access_token(
                            "new-local-id",
                            "workspace",
                            "new-access",
                            Some(&token),
                        ),
                )
                .unwrap();
            assert_eq!(
                ProviderService::managed_codex_oauth_account_id(
                    &state
                        .db
                        .get_provider_by_id("current", "codex")
                        .unwrap()
                        .unwrap()
                )
                .as_deref(),
                Some("old-local-id"),
                "a new account cannot silently capture the deleted account's binding"
            );

            let before = crate::codex_config::CodexLiveStateSnapshot::capture().unwrap();
            let error = ProviderService::switch(state, AppType::Codex, "current").unwrap_err();
            assert!(error.to_string().contains("选择账号"), "{error}");
            assert_eq!(
                crate::codex_config::CodexLiveStateSnapshot::capture().unwrap(),
                before,
                "selecting a stale account binding must leave native files unchanged"
            );
            assert_eq!(
                state.db.get_current_provider("codex").unwrap().as_deref(),
                Some("current")
            );

            let target =
                managed_codex_provider(if rebind { "current" } else { "target" }, "new-local-id");
            if rebind {
                ProviderService::update(state, AppType::Codex, None, target.clone()).unwrap();
            } else {
                state.db.save_provider("codex", &target).unwrap();
                ProviderService::switch(state, AppType::Codex, &target.id).unwrap();
            }
            let auth: Value = read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
            assert_eq!(
                auth["tokens"]["access_token"], "new-access",
                "rebind={rebind}"
            );
            assert_eq!(
                crate::mode::current::provider_for(
                    &state.db,
                    &AppType::Codex,
                    crate::mode::current::Purpose::InUse,
                )
                .unwrap()
                .as_deref(),
                Some(target.id.as_str())
            );
            assert!(
                crate::codex_config::codex_auth_matches_recorded_managed_oauth(
                    &auth,
                    "new-local-id",
                )
                .unwrap()
            );
            assert!(state
                .db
                .get_all_providers("codex")
                .unwrap()
                .values()
                .all(|provider| {
                    !provider.settings_config["config"]
                        .as_str()
                        .unwrap_or("")
                        .contains("PROXY_MANAGED")
                }));
        });
    }
}

#[test]
#[serial]
fn saved_legacy_codex_editor_opens_original_protocol_without_touching_live() {
    with_test_home(|state, _| {
        crate::settings::reload_settings().unwrap();
        let settings = json!({
            "auth": {"OPENAI_API_KEY": "sk-legacy"},
            "config": "# legacy snapshot\nmodel_provider = 'relay'\n[model_providers.relay]\nbase_url = 'https://relay.example/v1'\nwire_api = 'chat'\n"
        });
        let path = crate::codex_config::get_codex_config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "# client owns this\ninvalid = [").unwrap();
        let before = fs::read(&path).unwrap();
        let view = codex_editor::view(state, &settings, None).unwrap();
        assert_eq!(
            view.settings, settings,
            "legacy protocol and comments stay editable verbatim"
        );
        assert!(view.inactive.is_empty());
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "opening a legacy row never inspects or changes native live config"
        );
    });
}
