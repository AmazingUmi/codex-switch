use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptAppStatus {
    Installed,
    NotInstalled,
    Unavailable,
    Unsupported,
}

#[derive(Debug, Serialize)]
pub struct ChatGptAppVersion {
    status: ChatGptAppStatus,
    version: Option<String>,
    build_version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}

impl ChatGptAppVersion {
    fn empty(status: ChatGptAppStatus) -> Self {
        Self {
            status,
            version: None,
            build_version: None,
            path: None,
            error: None,
        }
    }
}

/// Read installed application metadata without launching the app or its updater.
#[tauri::command]
pub async fn get_chatgpt_app_version() -> Result<ChatGptAppVersion, String> {
    tokio::task::spawn_blocking(probe_chatgpt_app)
        .await
        .map_err(|error| format!("ChatGPT version check failed: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn probe_chatgpt_app() -> ChatGptAppVersion {
    ChatGptAppVersion::empty(ChatGptAppStatus::Unsupported)
}

#[cfg(target_os = "macos")]
fn probe_chatgpt_app() -> ChatGptAppVersion {
    let mut candidates = vec![std::path::PathBuf::from("/Applications/ChatGPT.app")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications/ChatGPT.app"));
    }
    probe_candidates(&candidates)
}

#[cfg(target_os = "macos")]
fn probe_candidates(candidates: &[std::path::PathBuf]) -> ChatGptAppVersion {
    let mut failure = None;
    for app_path in candidates {
        if !app_path.is_dir() {
            continue;
        }
        let result = read_app_metadata(app_path);
        match result {
            Ok(Some(version)) => return version,
            Ok(None) => continue,
            Err(error) => {
                let mut report = ChatGptAppVersion::empty(ChatGptAppStatus::Unavailable);
                report.path = Some(app_path.to_string_lossy().into_owned());
                report.error = Some(error);
                failure = Some(report);
            }
        }
    }
    failure.unwrap_or_else(|| ChatGptAppVersion::empty(ChatGptAppStatus::NotInstalled))
}

#[cfg(target_os = "macos")]
fn read_app_metadata(app_path: &std::path::Path) -> Result<Option<ChatGptAppVersion>, String> {
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "--"])
        .arg(app_path.join("Contents/Info.plist"))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("Could not read ChatGPT application metadata: {error}"))?;
    if !output.status.success() {
        return Err("Could not read ChatGPT application metadata".to_string());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid ChatGPT application metadata: {error}"))?;
    parse_app_metadata(&metadata, app_path)
}

#[cfg(target_os = "macos")]
fn parse_app_metadata(
    metadata: &serde_json::Value,
    app_path: &std::path::Path,
) -> Result<Option<ChatGptAppVersion>, String> {
    let text = |key: &str| {
        metadata[key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let is_chatgpt = match text("CFBundleIdentifier") {
        Some("com.openai.chat") => true,
        // The current ChatGPT desktop app retains the Codex bundle identifier.
        Some("com.openai.codex") => {
            text("CFBundleDisplayName").or_else(|| text("CFBundleName")) == Some("ChatGPT")
        }
        _ => false,
    };
    if !is_chatgpt {
        return Ok(None);
    }
    let version = text("CFBundleShortVersionString")
        .ok_or_else(|| "ChatGPT version is missing from application metadata".to_string())?;
    Ok(Some(ChatGptAppVersion {
        status: ChatGptAppStatus::Installed,
        version: Some(version.to_string()),
        build_version: text("CFBundleVersion").map(str::to_string),
        path: Some(app_path.to_string_lossy().into_owned()),
        error: None,
    }))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_chatgpt_id_and_current_chatgpt_desktop_identity() {
        for id in ["com.openai.chat", "com.openai.codex"] {
            let metadata = json!({
                "CFBundleIdentifier": id,
                "CFBundleDisplayName": "ChatGPT",
                "CFBundleShortVersionString": "26.930.31730",
                "CFBundleVersion": "12947"
            });
            let report = parse_app_metadata(&metadata, std::path::Path::new("/ChatGPT.app"))
                .unwrap()
                .unwrap();
            assert!(matches!(report.status, ChatGptAppStatus::Installed));
            assert_eq!(report.version.as_deref(), Some("26.930.31730"));
            assert_eq!(report.build_version.as_deref(), Some("12947"));
        }
    }

    #[test]
    fn rejects_other_apps_and_codex_desktop_even_if_filename_is_chatgpt() {
        for (id, name) in [
            ("com.example.app", "ChatGPT"),
            ("com.openai.codex", "Codex"),
        ] {
            assert!(parse_app_metadata(
                &json!({"CFBundleIdentifier": id, "CFBundleDisplayName": name}),
                std::path::Path::new("/ChatGPT.app")
            )
            .unwrap()
            .is_none());
        }
    }

    #[test]
    fn missing_version_is_an_error_not_an_absent_installation() {
        assert!(parse_app_metadata(
            &json!({"CFBundleIdentifier": "com.openai.chat", "CFBundleShortVersionString": " "}),
            std::path::Path::new("/ChatGPT.app")
        )
        .is_err());
    }

    #[test]
    fn distinguishes_absent_app_from_unreadable_metadata() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("ChatGPT.app");
        assert!(matches!(
            probe_candidates(std::slice::from_ref(&app)).status,
            ChatGptAppStatus::NotInstalled
        ));
        std::fs::create_dir(&app).unwrap();
        let report = probe_candidates(&[app]);
        assert!(matches!(report.status, ChatGptAppStatus::Unavailable));
        assert!(report.error.is_some());
    }

    #[test]
    fn reads_xml_plist_and_falls_back_to_user_installation() {
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("system/ChatGPT.app");
        let app = root.path().join("user/ChatGPT.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0"?>
            <plist version="1.0"><dict>
            <key>CFBundleIdentifier</key><string>com.openai.chat</string>
            <key>CFBundleShortVersionString</key><string>1.2.3</string>
            <key>CFBundleVersion</key><string>42</string>
            </dict></plist>"#,
        )
        .unwrap();
        let report = probe_candidates(&[absent, app]);
        assert!(matches!(report.status, ChatGptAppStatus::Installed));
        assert_eq!(report.version.as_deref(), Some("1.2.3"));
    }

    #[test]
    #[ignore = "Reads this machine's installed ChatGPT app"]
    fn reports_local_installation() {
        let report = probe_chatgpt_app();
        println!("{}", serde_json::to_string(&report).unwrap());
        assert!(matches!(report.status, ChatGptAppStatus::Installed));
    }
}
