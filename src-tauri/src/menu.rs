//! Application menu and navigation, independent of the status-bar menu.

use std::sync::atomic::{AtomicBool, Ordering};

/// Keep the intent in the app process while lightweight mode rebuilds the webview.
#[derive(Default)]
pub struct PendingSettingsNavigation(AtomicBool);

impl PendingSettingsNavigation {
    #[cfg(any(target_os = "macos", test))]
    fn request(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn take_for_window(&self, label: &str) -> bool {
        label == "main" && self.0.swap(false, Ordering::AcqRel)
    }
}

#[tauri::command]
pub fn take_pending_settings_navigation(
    window: tauri::WebviewWindow,
    pending: tauri::State<'_, PendingSettingsNavigation>,
) -> bool {
    pending.take_for_window(window.label())
}

// Tray menu callbacks also receive application menu events. Reserve this namespace
// so a future status-bar view can register its own actions without double handling.
pub const MENU_ID_PREFIX: &str = "native.";

#[cfg(target_os = "macos")]
pub use macos::{install, refresh};

#[cfg(target_os = "macos")]
mod macos {
    use super::PendingSettingsNavigation;
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    };
    use tauri::{Emitter, EventTarget, Manager};

    const SETTINGS: &str = "native.settings";
    const SHOW_MAIN: &str = "native.show-main";
    const QUIT: &str = "native.quit";

    struct MenuTexts {
        about: &'static str,
        settings: &'static str,
        services: &'static str,
        hide: &'static str,
        hide_others: &'static str,
        show_all: &'static str,
        quit: &'static str,
        file: &'static str,
        close: &'static str,
        edit: &'static str,
        undo: &'static str,
        redo: &'static str,
        cut: &'static str,
        copy: &'static str,
        paste: &'static str,
        select_all: &'static str,
        view: &'static str,
        fullscreen: &'static str,
        window: &'static str,
        show_main: &'static str,
        minimize: &'static str,
        zoom: &'static str,
    }

    impl MenuTexts {
        fn from_language(language: &str) -> Self {
            match language {
                "en" => Self {
                    about: "About {app}",
                    settings: "Settings…",
                    services: "Services",
                    hide: "Hide {app}",
                    hide_others: "Hide Others",
                    show_all: "Show All",
                    quit: "Quit {app}",
                    file: "File",
                    close: "Close Window",
                    edit: "Edit",
                    undo: "Undo",
                    redo: "Redo",
                    cut: "Cut",
                    copy: "Copy",
                    paste: "Paste",
                    select_all: "Select All",
                    view: "View",
                    fullscreen: "Enter Full Screen",
                    window: "Window",
                    show_main: "Open Main Window",
                    minimize: "Minimize",
                    zoom: "Zoom",
                },
                "ja" => Self {
                    about: "{app}について",
                    settings: "設定…",
                    services: "サービス",
                    hide: "{app}を非表示",
                    hide_others: "ほかを非表示",
                    show_all: "すべてを表示",
                    quit: "{app}を終了",
                    file: "ファイル",
                    close: "ウィンドウを閉じる",
                    edit: "編集",
                    undo: "取り消す",
                    redo: "やり直す",
                    cut: "カット",
                    copy: "コピー",
                    paste: "ペースト",
                    select_all: "すべてを選択",
                    view: "表示",
                    fullscreen: "フルスクリーンにする",
                    window: "ウィンドウ",
                    show_main: "メインウィンドウを開く",
                    minimize: "しまう",
                    zoom: "拡大／縮小",
                },
                "zh-TW" => Self {
                    about: "關於 {app}",
                    settings: "設定…",
                    services: "服務",
                    hide: "隱藏 {app}",
                    hide_others: "隱藏其他",
                    show_all: "顯示全部",
                    quit: "結束 {app}",
                    file: "檔案",
                    close: "關閉視窗",
                    edit: "編輯",
                    undo: "還原",
                    redo: "重做",
                    cut: "剪下",
                    copy: "拷貝",
                    paste: "貼上",
                    select_all: "全選",
                    view: "顯示方式",
                    fullscreen: "進入全螢幕",
                    window: "視窗",
                    show_main: "開啟主視窗",
                    minimize: "縮到最小",
                    zoom: "縮放",
                },
                _ => Self {
                    about: "关于 {app}",
                    settings: "设置…",
                    services: "服务",
                    hide: "隐藏 {app}",
                    hide_others: "隐藏其他",
                    show_all: "全部显示",
                    quit: "退出 {app}",
                    file: "文件",
                    close: "关闭窗口",
                    edit: "编辑",
                    undo: "撤销",
                    redo: "重做",
                    cut: "剪切",
                    copy: "拷贝",
                    paste: "粘贴",
                    select_all: "全选",
                    view: "显示",
                    fullscreen: "进入全屏幕",
                    window: "窗口",
                    show_main: "打开主窗口",
                    minimize: "最小化",
                    zoom: "缩放",
                },
            }
        }
    }

    fn create(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
        let settings = crate::settings::get_settings();
        let texts = MenuTexts::from_language(
            settings
                .language
                .as_deref()
                .unwrap_or_else(|| crate::tray::detect_system_tray_language()),
        );
        let app_name = app
            .config()
            .product_name
            .as_deref()
            .unwrap_or("Codex Switch");
        let app_menu = Submenu::with_items(
            app,
            app_name,
            true,
            &[
                &PredefinedMenuItem::about(
                    app,
                    Some(&texts.about.replace("{app}", app_name)),
                    Some(AboutMetadata {
                        name: Some(app_name.to_owned()),
                        version: Some(app.package_info().version.to_string()),
                        copyright: app.config().bundle.copyright.clone(),
                        icon: app.default_window_icon().cloned(),
                        ..Default::default()
                    }),
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, SETTINGS, texts.settings, true, Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, Some(texts.services))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some(&texts.hide.replace("{app}", app_name)))?,
                &PredefinedMenuItem::hide_others(app, Some(texts.hide_others))?,
                &PredefinedMenuItem::show_all(app, Some(texts.show_all))?,
                &PredefinedMenuItem::separator(app)?,
                // Route Quit through the app's explicit cleanup path instead of
                // Cocoa's predefined terminate action.
                &MenuItem::with_id(
                    app,
                    QUIT,
                    texts.quit.replace("{app}", app_name),
                    true,
                    Some("CmdOrCtrl+Q"),
                )?,
            ],
        )?;
        let file_menu = Submenu::with_items(
            app,
            texts.file,
            true,
            &[&PredefinedMenuItem::close_window(app, Some(texts.close))?],
        )?;
        let edit_menu = Submenu::with_items(
            app,
            texts.edit,
            true,
            &[
                &PredefinedMenuItem::undo(app, Some(texts.undo))?,
                &PredefinedMenuItem::redo(app, Some(texts.redo))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, Some(texts.cut))?,
                &PredefinedMenuItem::copy(app, Some(texts.copy))?,
                &PredefinedMenuItem::paste(app, Some(texts.paste))?,
                &PredefinedMenuItem::select_all(app, Some(texts.select_all))?,
            ],
        )?;
        let view_menu = Submenu::with_items(
            app,
            texts.view,
            true,
            &[&PredefinedMenuItem::fullscreen(
                app,
                Some(texts.fullscreen),
            )?],
        )?;
        let window_menu = Submenu::with_id_and_items(
            app,
            WINDOW_SUBMENU_ID,
            texts.window,
            true,
            &[
                &MenuItem::with_id(app, SHOW_MAIN, texts.show_main, true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::minimize(app, Some(texts.minimize))?,
                &PredefinedMenuItem::maximize(app, Some(texts.zoom))?,
            ],
        )?;
        Menu::with_items(
            app,
            &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
        )
    }

    fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
        crate::tray::apply_tray_policy(app, true);
        if app.get_webview_window("main").is_none() || crate::lightweight::is_lightweight_mode() {
            crate::lightweight::exit_lightweight_mode(app)?;
        }
        let window = app
            .get_webview_window("main")
            .ok_or("Main window unavailable")?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }

    fn open_settings(app: &tauri::AppHandle) -> Result<(), String> {
        app.state::<PendingSettingsNavigation>().request();
        show_main_window(app)?;
        // This is a wakeup, not the only copy of the intent. The frontend also
        // drains the queue once its listener has been installed after a reload.
        app.emit_to(
            EventTarget::webview_window("main"),
            "native-menu-open-settings",
            (),
        )
        .map_err(|e| e.to_string())
    }

    pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
        app.set_menu(create(app)?)?;
        app.on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                SETTINGS => open_settings(app),
                SHOW_MAIN => show_main_window(app),
                QUIT => {
                    app.exit(0);
                    Ok(())
                }
                _ => return,
            };
            if let Err(error) = result {
                log::error!("Native menu action {} failed: {error}", event.id.as_ref());
            }
        });
        Ok(())
    }

    pub fn refresh(app: &tauri::AppHandle) {
        if let Err(error) = create(app).and_then(|menu| app.set_menu(menu)) {
            log::error!("Failed to refresh application menu: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PendingSettingsNavigation;

    #[test]
    fn settings_intent_survives_until_main_window_consumes_it_once() {
        let pending = PendingSettingsNavigation::default();
        assert!(!pending.take_for_window("main"));
        pending.request();
        assert!(!pending.take_for_window("status-bar"));
        assert!(pending.take_for_window("main"));
        assert!(!pending.take_for_window("main"));
    }

    #[test]
    fn repeated_requests_coalesce_but_later_requests_still_navigate() {
        let pending = PendingSettingsNavigation::default();
        pending.request();
        pending.request();
        assert!(pending.take_for_window("main"));
        assert!(!pending.take_for_window("main"));
        pending.request();
        assert!(pending.take_for_window("main"));
    }
}
