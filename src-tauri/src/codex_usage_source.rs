//! Read-only Codex usage input. This root must never select auth/config write paths.

use std::path::{Path, PathBuf};

use crate::error::AppError;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSource {
    pub directory: String,
    pub default_directory: String,
}

fn default_directory(
    config_directory: PathBuf,
    actual_home: Option<&Path>,
    preview: bool,
) -> PathBuf {
    if preview {
        if let Some(home) = actual_home {
            return home.join(".codex");
        }
    }
    config_directory
}

fn resolve_directory(raw: &str, actual_home: Option<&Path>) -> PathBuf {
    if raw == "~" {
        if let Some(home) = actual_home {
            return home.to_path_buf();
        }
    }
    if let Some(suffix) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = actual_home {
            return suffix
                .split(['/', '\\'])
                .filter(|component| !component.is_empty())
                .fold(home.to_path_buf(), |path, component| path.join(component));
        }
    }
    PathBuf::from(raw)
}

pub(crate) fn validate_directory(raw: &str) -> Result<(), AppError> {
    let path = resolve_directory(raw, dirs::home_dir().as_deref());
    if !path.is_absolute() {
        return Err(AppError::InvalidInput(
            "Codex usage source must be an absolute directory or start with ~/".into(),
        ));
    }
    if !path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Codex usage source is not an existing directory: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn get_codex_usage_source_dir() -> PathBuf {
    let settings = crate::settings::get_settings();
    codex_usage_source_dir(&settings)
}

pub(crate) fn codex_usage_source_dir(settings: &crate::settings::AppSettings) -> PathBuf {
    if let Some(raw) = &settings.codex_usage_source_dir {
        return resolve_directory(raw, dirs::home_dir().as_deref());
    }
    get_default_codex_usage_source_dir()
}

fn get_default_codex_usage_source_dir() -> PathBuf {
    default_directory(
        crate::codex_config::get_codex_config_dir(),
        dirs::home_dir().as_deref(),
        // Unit tests keep their isolated config root. Preview releases deliberately
        // bypass CC_SWITCH_TEST_HOME only for this read-only usage source.
        cfg!(all(feature = "codex-preview", not(test))),
    )
}

pub(crate) fn get_codex_usage_source() -> CodexUsageSource {
    CodexUsageSource {
        directory: get_codex_usage_source_dir().to_string_lossy().into_owned(),
        default_directory: get_default_codex_usage_source_dir()
            .to_string_lossy()
            .into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_usage_source_is_independent_of_isolated_config_root() {
        let root = tempfile::tempdir().unwrap();
        let isolated_config = root.path().join("preview-home/.codex");
        let actual_home = root.path().join("actual-home");
        assert_eq!(
            default_directory(isolated_config.clone(), Some(&actual_home), true),
            actual_home.join(".codex")
        );
        assert_eq!(
            default_directory(isolated_config.clone(), Some(&actual_home), false),
            isolated_config
        );
    }

    #[test]
    fn usage_source_tilde_uses_actual_home() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_directory("~/.codex", Some(home.path())),
            home.path().join(".codex")
        );
        assert_eq!(
            resolve_directory(r"~\.codex", Some(home.path())),
            home.path().join(".codex")
        );
        assert_eq!(resolve_directory("~", Some(home.path())), home.path());
    }
}
