//! Isolated, persistent home for the opt-in desktop preview binary.
//! This runs before settings, database, OAuth or live-config initialization.
use std::path::PathBuf;

fn preview_home(explicit: Option<&str>, home: Option<PathBuf>) -> Result<PathBuf, String> {
    let path = match explicit {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => home
            .ok_or("Cannot locate the user home")?
            .join(".codex-switch-preview"),
    };
    if !path.is_absolute() {
        return Err("The preview home must be an absolute path".into());
    }
    Ok(path)
}

pub fn initialize() -> Result<(), String> {
    let explicit = std::env::var("CODEX_SWITCH_TEST_HOME").ok();
    let path = preview_home(explicit.as_deref(), dirs::home_dir())?;
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    // Set before the Tauri runtime creates threads. Reuse the existing tested
    // path resolver rather than changing OAuth or atomic live-config writes.
    std::env::set_var("CODEX_SWITCH_TEST_HOME", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_preview_home_is_separate_from_user_home() {
        let home = std::env::temp_dir();
        assert_eq!(
            preview_home(None, Some(home.clone())).unwrap(),
            home.join(".codex-switch-preview")
        );
    }

    #[test]
    fn explicit_isolated_smoke_home_is_preserved() {
        let isolated = std::env::temp_dir().join("codex-preview-smoke");
        assert_eq!(preview_home(isolated.to_str(), None).unwrap(), isolated);
    }

    #[test]
    fn invalid_home_must_not_fall_back_to_live_paths() {
        assert!(preview_home(Some("relative-home"), None).is_err());
        assert!(preview_home(None, None).is_err());
    }
}
