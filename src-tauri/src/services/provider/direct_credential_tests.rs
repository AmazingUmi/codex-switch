// Native credential safety uses independent account selection.

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
