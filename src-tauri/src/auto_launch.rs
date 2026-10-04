use crate::error::AppError;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

fn auto_launch_name(preview: bool) -> &'static str {
    if preview {
        "Codex Switch Preview"
    } else {
        "Codex Switch"
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_auto_launch_path(path: &std::path::Path) -> String {
    // auto-launch 0.5 writes app_path directly into the HKCU Run command.
    // Quote the executable so spaces in the install or user directory stay in it.
    format!("\"{}\"", path.to_string_lossy())
}

/// 获取 macOS 上的 .app bundle 路径
/// 将 `/path/to/Codex Switch.app/Contents/MacOS/Codex Switch` 转换为 `/path/to/Codex Switch.app`
#[cfg(target_os = "macos")]
fn get_macos_app_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let path_str = exe_path.to_string_lossy();
    // 查找 .app/Contents/MacOS/ 模式
    if let Some(app_pos) = path_str.find(".app/Contents/MacOS/") {
        let app_bundle_end = app_pos + 4; // ".app" 的结束位置
        Some(std::path::PathBuf::from(&path_str[..app_bundle_end]))
    } else {
        None
    }
}

/// 初始化 AutoLaunch 实例
fn get_auto_launch() -> Result<AutoLaunch, AppError> {
    let app_name = auto_launch_name(cfg!(feature = "codex-preview"));
    let exe_path =
        std::env::current_exe().map_err(|e| AppError::Message(format!("无法获取应用路径: {e}")))?;

    // macOS 需要使用 .app bundle 路径，否则 AppleScript login item 会打开终端
    #[cfg(target_os = "macos")]
    let app_path = get_macos_app_bundle_path(&exe_path).unwrap_or(exe_path);

    #[cfg(not(target_os = "macos"))]
    let app_path = exe_path;

    #[cfg(target_os = "windows")]
    let app_path = windows_auto_launch_path(&app_path);
    #[cfg(not(target_os = "windows"))]
    let app_path = app_path.to_string_lossy().into_owned();

    // 使用 AutoLaunchBuilder 消除平台差异
    // macOS: 使用 AppleScript 方式（默认），需要 .app bundle 路径
    // Windows/Linux: 使用注册表/XDG autostart
    let auto_launch = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&app_path)
        .build()
        .map_err(|e| AppError::Message(format!("创建 AutoLaunch 失败: {e}")))?;

    Ok(auto_launch)
}

/// 启用开机自启
pub fn enable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .enable()
        .map_err(|e| AppError::Message(format!("启用开机自启失败: {e}")))?;
    log::info!("已启用开机自启");
    Ok(())
}

/// 禁用开机自启
pub fn disable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .disable()
        .map_err(|e| AppError::Message(format!("禁用开机自启失败: {e}")))?;
    log::info!("已禁用开机自启");
    Ok(())
}

/// 检查是否已启用开机自启
pub fn is_auto_launch_enabled() -> Result<bool, AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .is_enabled()
        .map_err(|e| AppError::Message(format!("检查开机自启状态失败: {e}")))
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn windows_startup_command_preserves_spaces_and_unicode() {
        let exe = std::path::Path::new(
            r"C:\Users\测试 User\AppData\Local\Programs\Codex Switch\codex-switch.exe",
        );
        assert_eq!(
            windows_auto_launch_path(exe),
            "\"C:\\Users\\测试 User\\AppData\\Local\\Programs\\Codex Switch\\codex-switch.exe\""
        );
    }

    #[test]
    fn preview_startup_registration_is_independent() {
        assert_eq!(auto_launch_name(false), "Codex Switch");
        assert_eq!(auto_launch_name(true), "Codex Switch Preview");
        assert_ne!(auto_launch_name(false), auto_launch_name(true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_valid() {
        let exe_path =
            std::path::Path::new("/Applications/Codex Switch.app/Contents/MacOS/Codex Switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from("/Applications/Codex Switch.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_with_spaces() {
        let exe_path = std::path::Path::new(
            "/Users/test/My Apps/Codex Switch.app/Contents/MacOS/Codex Switch",
        );
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from(
                "/Users/test/My Apps/Codex Switch.app"
            ))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_not_in_bundle() {
        let exe_path = std::path::Path::new("/usr/local/bin/codex-switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_dev_build() {
        // 开发环境下的路径通常不在 .app bundle 内
        let exe_path = std::path::Path::new("/Users/dev/project/target/debug/codex-switch");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }
}
