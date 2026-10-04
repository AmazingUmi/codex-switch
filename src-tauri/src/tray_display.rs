//! Native menu-bar and Windows notification-area presentation. Quota identity and freshness live in tray_quota.

#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::settings::TrayDisplayMode;
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use crate::settings::{AppSettings, TrayQuotaColorMode, TrayQuotaWindow};
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use crate::tray_quota::{TrayQuotaSnapshot, TrayQuotaStatus, TrayQuotaWindowSnapshot};

/// Preserve the meaningful boundaries: a positive remainder is never shown as 0%.
pub(crate) fn remaining_text(remaining: Option<f64>, stale: bool) -> String {
    let Some(value) = remaining.filter(|v| v.is_finite() && (0.0..=100.0).contains(v)) else {
        return "—".to_owned();
    };
    let number = if value > 0.0 && value < 1.0 {
        "<1".to_owned()
    } else if value > 99.0 && value < 100.0 {
        "99".to_owned()
    } else {
        format!("{value:.0}")
    };
    format!("{}{number}%", if stale { "~" } else { "" })
}

/// Windows details retain two decimal places, including a positive sub-percent balance.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn precise_remaining_text(value: Option<f64>, stale: bool) -> String {
    let Some(value) = value.filter(|v| v.is_finite() && (0.0..=100.0).contains(v)) else {
        return "—".into();
    };
    let number = if value > 0.0 && value < 0.01 {
        "<0.01".into()
    } else if value > 99.99 && value < 100.0 {
        ">99.99".into()
    } else {
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    };
    format!("{}{number}%", if stale { "~" } else { "" })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
enum RingTone {
    System,
    Warning,
    Low,
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn ring_tone(value: Option<f64>, stale: bool, settings: &AppSettings) -> RingTone {
    if stale || settings.tray_quota_color_mode == TrayQuotaColorMode::System {
        return RingTone::System;
    }
    match value {
        Some(v) if v <= settings.quota_battery_low_threshold_percent => RingTone::Low,
        Some(v) if v <= settings.quota_battery_warning_threshold_percent => RingTone::Warning,
        _ => RingTone::System,
    }
}

/// 3x pixels become an 18pt native image; supersampling keeps the ring clean at 1x/2x.
#[cfg(any(test, target_os = "macos"))]
fn ring_rgba(value: Option<f64>, tone: RingTone) -> Vec<u8> {
    ring_raster(value, tone, 54, None)
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn ring_raster(
    value: Option<f64>,
    tone: RingTone,
    size: usize,
    light_taskbar: Option<bool>,
) -> Vec<u8> {
    const SAMPLES: usize = 4;
    let (foreground, track) = ring_palette(tone, light_taskbar);
    let fraction = value.map(|v| v.clamp(0.0, 100.0) / 100.0);
    let mut pixels = vec![0; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let mut premultiplied = [0.0; 3];
            let mut alpha = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let dx =
                        (x as f64 + (sx as f64 + 0.5) / SAMPLES as f64) * 54.0 / size as f64 - 27.0;
                    let dy =
                        (y as f64 + (sy as f64 + 0.5) / SAMPLES as f64) * 54.0 / size as f64 - 27.0;
                    let radius = dx.hypot(dy);
                    if !(18.0..=24.0).contains(&radius) {
                        continue;
                    }
                    let angle = (dx.atan2(-dy) / std::f64::consts::TAU).rem_euclid(1.0);
                    // Missing quota has a broken outline, distinct from a real empty ring.
                    if fraction.is_none() && (angle * 12.0).fract() > 0.55 {
                        continue;
                    }
                    let filled = fraction.is_some_and(|v| angle < v);
                    let a = if filled {
                        255.0
                    } else if fraction.is_none() {
                        120.0
                    } else {
                        65.0
                    };
                    let color = if filled { foreground } else { track };
                    alpha += a;
                    for c in 0..3 {
                        premultiplied[c] += color[c] as f64 * a;
                    }
                }
            }
            let index = (y * size + x) * 4;
            if alpha > 0.0 {
                for c in 0..3 {
                    pixels[index + c] = (premultiplied[c] / alpha).round() as u8;
                }
                pixels[index + 3] = (alpha / (SAMPLES * SAMPLES) as f64).round() as u8;
            }
        }
    }
    pixels
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn ring_palette(tone: RingTone, light_taskbar: Option<bool>) -> ([u8; 3], [u8; 3]) {
    match light_taskbar {
        None => {
            let foreground = match tone {
                RingTone::System => [0, 0, 0],
                RingTone::Warning => [213, 142, 0],
                RingTone::Low => [218, 58, 70],
            };
            (
                foreground,
                if tone == RingTone::System {
                    [0, 0, 0]
                } else {
                    [128, 128, 128]
                },
            )
        }
        Some(light) => {
            let neutral = if light { [35, 35, 35] } else { [235, 235, 235] };
            let foreground = match (tone, light) {
                (RingTone::System, _) => neutral,
                (RingTone::Warning, true) => [170, 92, 0],
                (RingTone::Warning, false) => [255, 190, 80],
                (RingTone::Low, true) => [194, 34, 57],
                (RingTone::Low, false) => [255, 112, 124],
            };
            (foreground, neutral)
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_light_taskbar() -> bool {
    // SystemUsesLightTheme describes Explorer's taskbar, independently of the
    // app's theme and AppsUseLightTheme. Dark is a legible fallback on Windows.
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        .and_then(|key| key.get_value::<u32, _>("SystemUsesLightTheme"))
        .map(|value| value != 0)
        .unwrap_or(false)
}

/// Render at 3x Windows' 16px base size. A compact bitmap number avoids font or
/// platform dependencies; the tooltip/menu contains the percentage and full detail.
#[cfg(any(test, target_os = "windows"))]
fn windows_ring_rgba(
    value: Option<f64>,
    tone: RingTone,
    number: bool,
    light_taskbar: bool,
) -> Vec<u8> {
    let mut pixels = ring_raster(value, tone, 48, Some(light_taskbar));
    if !number {
        return pixels;
    }
    let number = remaining_text(value, false)
        .trim_end_matches('%')
        .to_owned();
    let glyph = |c| -> [u8; 5] {
        match c {
            '0' => [7, 5, 5, 5, 7],
            '1' => [2, 6, 2, 2, 7],
            '2' => [7, 1, 7, 4, 7],
            '3' => [7, 1, 7, 1, 7],
            '4' => [5, 5, 7, 1, 1],
            '5' => [7, 4, 7, 1, 7],
            '6' => [7, 4, 7, 5, 7],
            '7' => [7, 1, 1, 1, 1],
            '8' => [7, 5, 7, 5, 7],
            '9' => [7, 5, 7, 1, 7],
            '<' => [1, 2, 4, 2, 1],
            _ => [0, 0, 7, 0, 0],
        }
    };
    // At 16px, 100 uses a 10px-wide badge, fitting inside the ring. Keep
    // two-digit values aligned to the 3x pixel grid for sharp base-size digits.
    let stride = if number.len() == 3 { 11 } else { 12 };
    let width = (number.chars().count() - 1) * stride + 9;
    let x_start = (48 - width) / 2;
    let (foreground, _) = ring_palette(tone, Some(light_taskbar));
    for (index, c) in number.chars().enumerate() {
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..3 {
                if bits & (1 << (2 - col)) == 0 {
                    continue;
                }
                for dy in 0..3 {
                    for dx in 0..3 {
                        let offset =
                            ((15 + row * 3 + dy) * 48 + x_start + index * stride + col * 3 + dx)
                                * 4;
                        pixels[offset..offset + 3].copy_from_slice(&foreground);
                        pixels[offset + 3] = 255;
                    }
                }
            }
        }
    }
    pixels
}

/// The Shell notification tooltip holds 128 UTF-16 units including its terminator.
#[cfg(any(test, target_os = "windows"))]
fn bounded_tooltip(text: &str) -> String {
    let mut result = String::new();
    let mut units = 0;
    for c in text.chars() {
        if units + c.len_utf16() > 126 {
            result.push('…');
            return result;
        }
        result.push(c);
        units += c.len_utf16();
    }
    result
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
struct Labels {
    menu_bar: &'static str,
    tray: &'static str,
    #[cfg(any(test, target_os = "windows"))]
    details: &'static str,
    remaining: &'static str,
    five_hour: &'static str,
    seven_day: &'static str,
    reset: &'static str,
    updated: &'static str,
    stale: &'static str,
    unavailable: &'static str,
    ready: &'static str,
    expired: &'static str,
    unsupported: &'static str,
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn labels(language: &str) -> Labels {
    match language {
        "en" => Labels {
            menu_bar: "Menu bar",
            tray: "System tray",
            #[cfg(any(test, target_os = "windows"))]
            details: "Quota details",
            remaining: "Remaining",
            five_hour: "5 hours",
            seven_day: "Weekly",
            reset: "Resets",
            updated: "Updated",
            stale: "Refresh failed · last known quota",
            unavailable: "Quota unavailable",
            ready: "Current quota",
            expired: "Sign in again",
            unsupported: "This connection has no supported subscription quota",
        },
        "ja" => Labels {
            menu_bar: "メニューバー",
            tray: "通知領域",
            #[cfg(any(test, target_os = "windows"))]
            details: "残量の詳細",
            remaining: "残り",
            five_hour: "5 時間",
            seven_day: "週間",
            reset: "リセット",
            updated: "更新",
            stale: "更新失敗 · 前回の残量",
            unavailable: "残量を取得できません",
            ready: "現在の残量",
            expired: "再ログインしてください",
            unsupported: "この接続のサブスクリプション残量には対応していません",
        },
        "zh-TW" => Labels {
            menu_bar: "狀態列",
            tray: "系統匣",
            #[cfg(any(test, target_os = "windows"))]
            details: "額度詳情",
            remaining: "剩餘",
            five_hour: "5 小時",
            seven_day: "每週",
            reset: "重置",
            updated: "更新",
            stale: "重新整理失敗 · 上次額度",
            unavailable: "額度暫不可用",
            ready: "目前額度",
            expired: "登入已失效，請重新登入",
            unsupported: "目前連線不支援訂閱額度",
        },
        _ => Labels {
            menu_bar: "状态栏",
            tray: "系统托盘",
            #[cfg(any(test, target_os = "windows"))]
            details: "额度详情",
            remaining: "剩余",
            five_hour: "5 小时",
            seven_day: "每周",
            reset: "重置",
            updated: "更新",
            stale: "刷新失败 · 上次额度",
            unavailable: "额度暂不可用",
            ready: "当前额度",
            expired: "登录已失效，请重新登录",
            unsupported: "当前连接不支持订阅额度",
        },
    }
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn window_line(
    label: &str,
    window: Option<&TrayQuotaWindowSnapshot>,
    stale: bool,
    text: &Labels,
    precise: bool,
) -> String {
    let value = if precise {
        precise_remaining_text(window.map(|w| w.remaining), stale)
    } else {
        remaining_text(window.map(|w| w.remaining), stale)
    };
    let reset = window
        .and_then(|w| w.resets_at.as_deref())
        .and_then(|r| chrono::DateTime::parse_from_rfc3339(r).ok())
        .map(|r| {
            format!(
                " · {} {}",
                text.reset,
                r.with_timezone(&chrono::Local).format("%m-%d %H:%M")
            )
        })
        .unwrap_or_default();
    format!("{label} {} {value}{reset}", text.remaining)
}

/// Some plans only return a weekly quota. The setting is the preferred window,
/// not a requirement that hides the account's other available quota on switch.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn selected_window(
    snapshot: &TrayQuotaSnapshot,
    preferred: TrayQuotaWindow,
) -> Option<(TrayQuotaWindow, &TrayQuotaWindowSnapshot)> {
    if !matches!(
        snapshot.status,
        TrayQuotaStatus::Ready | TrayQuotaStatus::Stale
    ) {
        return None;
    }
    let five_hour = snapshot
        .five_hour
        .as_ref()
        .map(|window| (TrayQuotaWindow::FiveHour, window));
    let seven_day = snapshot
        .seven_day
        .as_ref()
        .map(|window| (TrayQuotaWindow::SevenDay, window));
    match preferred {
        TrayQuotaWindow::FiveHour => five_hour.or(seven_day),
        TrayQuotaWindow::SevenDay => seven_day.or(five_hour),
    }
}

#[cfg(any(test, target_os = "macos"))]
fn tooltip(snapshot: &TrayQuotaSnapshot, language: &str, preferred: TrayQuotaWindow) -> String {
    quota_description(snapshot, language, preferred, false)
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn quota_description(
    snapshot: &TrayQuotaSnapshot,
    language: &str,
    preferred: TrayQuotaWindow,
    portable: bool,
) -> String {
    let text = labels(language);
    let mut lines = vec!["Codex Switch".to_owned()];
    if let Some(label) = &snapshot.account_label {
        // Keep account remarks to one tooltip line; don't leak credentials or raw errors.
        lines.push(
            label
                .replace(['\n', '\r', '\t'], " ")
                .chars()
                .take(160)
                .collect(),
        );
    } else if portable {
        lines.push("—".into());
    }
    let stale = snapshot.status == TrayQuotaStatus::Stale;
    let usable = matches!(
        snapshot.status,
        TrayQuotaStatus::Ready | TrayQuotaStatus::Stale
    );
    let selected = selected_window(snapshot, preferred);
    if let Some((kind, window)) = selected {
        let label = match kind {
            TrayQuotaWindow::FiveHour => text.five_hour,
            TrayQuotaWindow::SevenDay => text.seven_day,
        };
        lines.push(format!(
            "{}: {}",
            if portable { text.tray } else { text.menu_bar },
            window_line(label, Some(window), stale, &text, portable)
        ));
    }
    // Include the other window, including an unavailable preferred window, so
    // the tooltip identifies the fallback without suggesting both limits exist.
    if selected.is_none_or(|(kind, _)| kind != TrayQuotaWindow::FiveHour) {
        lines.push(window_line(
            text.five_hour,
            snapshot.five_hour.as_ref().filter(|_| usable),
            stale,
            &text,
            portable,
        ));
    }
    if selected.is_none_or(|(kind, _)| kind != TrayQuotaWindow::SevenDay) {
        lines.push(window_line(
            text.seven_day,
            snapshot.seven_day.as_ref().filter(|_| usable),
            stale,
            &text,
            portable,
        ));
    }
    let status = match snapshot.status {
        TrayQuotaStatus::Ready => portable.then_some(text.ready),
        TrayQuotaStatus::Stale => Some(text.stale),
        TrayQuotaStatus::Unavailable => Some(text.unavailable),
        TrayQuotaStatus::Expired => Some(text.expired),
        TrayQuotaStatus::Unsupported => Some(text.unsupported),
    };
    if let Some(status) = status {
        lines.push(status.to_owned());
    }
    let updated = snapshot
        .updated_at
        .and_then(chrono::DateTime::from_timestamp_millis);
    if let Some(at) = updated {
        lines.push(format!(
            "{} {}",
            text.updated,
            at.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S")
        ));
    }
    if portable && updated.is_none() {
        lines.push(format!("{} —", text.updated));
    }
    lines.join("\n")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
static DISPLAY_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn update(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let revision = DISPLAY_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // DB/config/auth source reads never block native event processing.
        let settings = crate::settings::get_settings();
        let snapshot = crate::tray_quota::snapshot(&handle);
        let main_handle = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            // A late projection from before an account/settings change is ignored.
            if DISPLAY_REVISION.load(Ordering::Acquire) == revision {
                apply_on_main_thread(&main_handle, settings, snapshot);
            }
        }) {
            log::warn!("Scheduling tray display update failed: {error}");
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_on_main_thread(
    app: &tauri::AppHandle,
    settings: AppSettings,
    snapshot: TrayQuotaSnapshot,
) {
    use once_cell::sync::Lazy;
    use std::sync::Mutex;
    // The same native icon is reused; menu tracking is never interrupted by a redraw.
    type AppliedDisplay = (String, String, Option<u64>, RingTone, bool, usize);
    static APPLIED: Lazy<Mutex<Option<AppliedDisplay>>> = Lazy::new(|| Mutex::new(None));
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return;
    };
    let ring = settings.tray_display_mode != TrayDisplayMode::Icon;
    let language = settings
        .language
        .as_deref()
        .map(crate::tray::map_locale_to_tray_language)
        .unwrap_or_else(crate::tray::detect_system_tray_language);
    let selected = selected_window(&snapshot, settings.tray_quota_window);
    let value = selected.map(|(_, window)| window.remaining);
    let stale = snapshot.status == TrayQuotaStatus::Stale;
    let title = if settings.tray_display_mode == TrayDisplayMode::QuotaRing {
        remaining_text(value, stale)
    } else {
        String::new()
    };
    let tooltip = tooltip(&snapshot, language, settings.tray_quota_window);
    let tone = ring_tone(value, stale, &settings);
    let native_id = tray
        .with_inner_tray_icon(|inner| {
            inner
                .ns_status_item()
                .map(|item| (&*item as *const _) as usize)
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let key = (
        title.clone(),
        tooltip.clone(),
        value.map(f64::to_bits),
        tone,
        ring,
        native_id,
    );
    let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
    if applied.as_ref() == Some(&key) {
        return;
    }
    let icon = if ring {
        tauri::image::Image::new_owned(ring_rgba(value, tone), 54, 54)
    } else {
        let Some(icon) = crate::macos_tray_icon() else {
            return;
        };
        icon
    };
    let result = tray.with_inner_tray_icon(move |inner| -> Result<(), String> {
        let icon = icon.try_into().map_err(|e| format!("{e}"))?;
        inner.set_icon_with_as_template(Some(icon), !ring || tone == RingTone::System)
            .map_err(|e| e.to_string())?;
        if let Some(item) = inner.ns_status_item() {
            // SAFETY: with_inner_tray_icon executes on AppKit's main thread.
            // Reserving the longest quota title prevents adjacent menu items jumping.
            item.setLength(match settings.tray_display_mode {
                TrayDisplayMode::Icon => -1.0,
                TrayDisplayMode::QuotaRing => 60.0,
                TrayDisplayMode::QuotaRingOnly => 24.0,
            });
            if ring {
                use objc2::{class, msg_send, runtime::AnyObject};
                // The two objc2 crate versions share Objective-C's stable object ABI.
                // The retained NSStatusItem remains alive throughout these sends.
                unsafe {
                    let item = (&*item as *const _) as *const AnyObject;
                    let button: *mut AnyObject = msg_send![item, button];
                    let font: *mut AnyObject = msg_send![class!(NSFont), monospacedDigitSystemFontOfSize: 11.0f64 weight: 0.0f64];
                    if !button.is_null() && !font.is_null() {
                        let _: () = msg_send![button, setFont: font];
                    }
                }
            }
        }
        // An empty string clears the old title; None does not on macOS tray-icon.
        // set_title also resizes tray-icon's pointer tracking after setLength.
        inner.set_title(Some(title));
        inner.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())
    });
    match result {
        Ok(Ok(())) => *applied = Some(key),
        Ok(Err(error)) => log::warn!("Updating tray display failed: {error}"),
        Err(error) => log::warn!("Updating tray display failed: {error}"),
    }
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn windows_details(
    snapshot: &TrayQuotaSnapshot,
    language: &str,
    preferred: TrayQuotaWindow,
) -> (&'static str, Vec<String>) {
    (
        labels(language).details,
        quota_description(snapshot, language, preferred, true)
            .lines()
            .skip(1)
            .map(str::to_owned)
            .collect(),
    )
}

#[cfg(target_os = "windows")]
fn apply_on_main_thread(
    app: &tauri::AppHandle,
    settings: AppSettings,
    snapshot: TrayQuotaSnapshot,
) {
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return;
    };
    let language = settings
        .language
        .as_deref()
        .map(crate::tray::map_locale_to_tray_language)
        .unwrap_or_else(crate::tray::detect_system_tray_language);
    let selected = selected_window(&snapshot, settings.tray_quota_window);
    let value = selected.map(|(_, window)| window.remaining);
    let stale = snapshot.status == TrayQuotaStatus::Stale;
    let icon = match settings.tray_display_mode {
        TrayDisplayMode::Icon => app.default_window_icon().cloned(),
        mode => Some(tauri::image::Image::new_owned(
            windows_ring_rgba(
                value,
                ring_tone(value, stale, &settings),
                mode == TrayDisplayMode::QuotaRing,
                windows_light_taskbar(),
            ),
            48,
            48,
        )),
    };
    if let Err(error) = tray.set_icon(icon) {
        log::warn!("Updating Windows tray icon failed: {error}");
    }
    // Native tooltips have limited space. Put the selected quota first; the menu
    // uses the same snapshot and preserves both reset times and the account label.
    let description = quota_description(&snapshot, language, settings.tray_quota_window, true);
    let lines: Vec<_> = description.lines().collect();
    let compact = format!("Codex Switch\n{}\n{}\n{}", lines[2], lines[4], lines[1]);
    if let Err(error) = tray.set_tooltip(Some(bounded_tooltip(&compact))) {
        log::warn!("Updating Windows tray tooltip failed: {error}");
    }
    let (title, details) = windows_details(&snapshot, language, settings.tray_quota_window);
    crate::tray::update_windows_quota_details(title, &details);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn update(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_quota(five_hour: Option<f64>, seven_day: Option<f64>) -> TrayQuotaSnapshot {
        let window = |remaining| TrayQuotaWindowSnapshot {
            remaining,
            resets_at: None,
        };
        TrayQuotaSnapshot {
            account_label: Some("Account".into()),
            five_hour: five_hour.map(window),
            seven_day: seven_day.map(window),
            status: TrayQuotaStatus::Ready,
            updated_at: None,
        }
    }

    #[test]
    fn windows_ring_palette_matches_system_taskbar_with_readable_threshold_colors() {
        let luminance = |rgb: [u8; 3]| {
            rgb.iter()
                .zip([0.2126, 0.7152, 0.0722])
                .map(|(value, weight)| {
                    let channel = *value as f64 / 255.0;
                    weight
                        * if channel <= 0.04045 {
                            channel / 12.92
                        } else {
                            ((channel + 0.055) / 1.055).powf(2.4)
                        }
                })
                .sum::<f64>()
        };
        for tone in [RingTone::System, RingTone::Warning, RingTone::Low] {
            for light in [true, false] {
                let (foreground, _) = ring_palette(tone, Some(light));
                let lum = luminance(foreground);
                let contrast = if light {
                    1.05 / (lum + 0.05)
                } else {
                    (lum + 0.05) / 0.05
                };
                assert!(contrast >= 4.5, "{tone:?} on light={light}: {contrast}");
                assert_ne!(
                    windows_ring_rgba(Some(36.0), tone, true, light),
                    windows_ring_rgba(Some(36.0), tone, true, !light)
                );
            }
        }
    }

    #[test]
    fn windows_modes_have_distinct_icons_and_preserve_unknown_zero_full() {
        for number in [false, true] {
            let unknown = windows_ring_rgba(None, RingTone::System, number, true);
            let zero = windows_ring_rgba(Some(0.0), RingTone::System, number, true);
            let full = windows_ring_rgba(Some(100.0), RingTone::System, number, true);
            assert_eq!(unknown.len(), 48 * 48 * 4);
            assert_ne!(unknown, zero);
            assert_ne!(zero, full);
            let settings = AppSettings::default();
            let ready = windows_ring_rgba(
                Some(5.0),
                ring_tone(Some(5.0), false, &settings),
                number,
                true,
            );
            let stale = windows_ring_rgba(
                Some(5.0),
                ring_tone(Some(5.0), true, &settings),
                number,
                true,
            );
            assert_ne!(ready, stale);
            assert!(full[..48 * 4].iter().all(|v| *v == 0));
        }
        assert_ne!(
            windows_ring_rgba(Some(36.0), RingTone::System, true, true),
            windows_ring_rgba(Some(36.0), RingTone::System, false, true)
        );
        // The centered 100 badge fits inside the ring.
        let full = windows_ring_rgba(Some(100.0), RingTone::System, true, true);
        assert!(full
            .chunks_exact(4)
            .enumerate()
            .any(|(i, pixel)| i / 48 == 18 && (12..36).contains(&(i % 48)) && pixel[3] == 255));
    }

    #[test]
    fn windows_number_badges_remain_distinct_at_16_and_32_pixels() {
        // Sample the native raster at both supported scale factors. Numeric
        // content remains different from the ring alone and other quota states.
        for size in [16, 32] {
            let sample = |pixels: Vec<u8>| -> Vec<u8> {
                (0..size)
                    .flat_map(|y| {
                        (0..size).map(move |x| ((y * 48 / size) * 48 + x * 48 / size) * 4)
                    })
                    .map(|offset| pixels[offset + 3])
                    .collect()
            };
            let mut states = Vec::new();
            for value in [
                None,
                Some(0.0),
                Some(0.1),
                Some(36.0),
                Some(99.9),
                Some(100.0),
            ] {
                let number = sample(windows_ring_rgba(value, RingTone::System, true, false));
                let ring = sample(windows_ring_rgba(value, RingTone::System, false, false));
                assert!(number.iter().zip(&ring).filter(|(a, b)| a != b).count() >= 3);
                assert!(states.iter().all(|previous| previous != &number));
                states.push(number);
            }
        }
    }

    #[test]
    fn windows_details_use_precise_values_and_hide_invalid_account_values() {
        let mut snapshot = account_quota(Some(36.25), Some(0.005));
        snapshot.account_label = Some("Account\nremark".into());
        snapshot.five_hour.as_mut().unwrap().resets_at = Some("2026-10-04T12:00:00Z".into());
        snapshot.updated_at = Some(1_791_078_000_000);
        snapshot.status = TrayQuotaStatus::Stale;
        let text = quota_description(&snapshot, "en", TrayQuotaWindow::FiveHour, true);
        assert!(text.contains("Account remark"));
        assert!(text.contains("System tray: 5 hours Remaining ~36.25%"));
        assert!(text.contains("Weekly Remaining ~<0.01%"));
        assert!(text.contains("Resets "));
        assert!(text.contains("Updated "));
        assert!(text.contains("Refresh failed"));
        assert_eq!(text.lines().count(), 6);
        for status in [
            TrayQuotaStatus::Unavailable,
            TrayQuotaStatus::Expired,
            TrayQuotaStatus::Unsupported,
        ] {
            snapshot.status = status;
            let text = quota_description(&snapshot, "en", TrayQuotaWindow::FiveHour, true);
            assert!(text.contains("5 hours Remaining —"));
            assert!(!text.contains("36.25"));
            assert!(!text.contains("Resets "));
            assert_eq!(text.lines().count(), 6);
        }
        assert_eq!(precise_remaining_text(Some(0.0), false), "0%");
        assert_eq!(precise_remaining_text(Some(100.0), false), "100%");
        assert_eq!(precise_remaining_text(None, true), "—");
    }

    #[test]
    fn windows_menu_details_keep_five_rows_across_account_states_and_locales() {
        for language in ["en", "zh", "zh-TW", "ja"] {
            for preferred in [TrayQuotaWindow::FiveHour, TrayQuotaWindow::SevenDay] {
                for status in [
                    TrayQuotaStatus::Ready,
                    TrayQuotaStatus::Stale,
                    TrayQuotaStatus::Unavailable,
                    TrayQuotaStatus::Expired,
                    TrayQuotaStatus::Unsupported,
                ] {
                    for (five_hour, seven_day) in [
                        (None, None),
                        (Some(0.0), None),
                        (None, Some(100.0)),
                        (Some(0.1), Some(99.9)),
                    ] {
                        for account in [None, Some("Account\nremark & 🐈".to_owned())] {
                            let mut snapshot = account_quota(five_hour, seven_day);
                            snapshot.status = status;
                            snapshot.account_label = account;
                            // An invalid timestamp must retain the final placeholder row.
                            snapshot.updated_at = Some(i64::MAX);
                            let (title, details) = windows_details(&snapshot, language, preferred);
                            assert!(!title.is_empty());
                            assert_eq!(details.len(), 5, "{language} {status:?}");
                            assert!(details
                                .iter()
                                .all(|line| !line.contains('\n') && !line.is_empty()));
                            assert!(details[4].ends_with('—'));
                            if !matches!(status, TrayQuotaStatus::Ready | TrayQuotaStatus::Stale) {
                                assert!(details[1].ends_with('—'));
                                assert!(details[2].ends_with('—'));
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn windows_tooltip_respects_utf16_shell_limit_without_splitting_unicode() {
        for value in ["a".repeat(200), "🐈".repeat(100), "帳號".repeat(100)] {
            let result = bounded_tooltip(&value);
            assert!(result.encode_utf16().count() <= 127);
            assert!(result.ends_with('…'));
        }
        assert_eq!(bounded_tooltip("Remaining 36.25%"), "Remaining 36.25%");
    }

    #[test]
    fn switching_to_weekly_only_account_keeps_available_quota_and_identifies_window() {
        let preferred = TrayQuotaWindow::FiveHour;
        let first = account_quota(Some(45.0), Some(91.0));
        let weekly_only = account_quota(None, Some(99.0));
        let switched_back = account_quota(Some(36.0), Some(80.0));
        for (snapshot, expected_kind, expected_value) in [
            (&first, TrayQuotaWindow::FiveHour, 45.0),
            (&weekly_only, TrayQuotaWindow::SevenDay, 99.0),
            (&switched_back, TrayQuotaWindow::FiveHour, 36.0),
        ] {
            let (kind, window) = selected_window(snapshot, preferred).unwrap();
            assert_eq!(kind, expected_kind);
            assert_eq!(window.remaining, expected_value);
        }
        let text = tooltip(&weekly_only, "en", preferred);
        assert!(text.contains("Menu bar: Weekly Remaining 99%"));
        assert!(text.contains("5 hours Remaining —"));
        assert!(!text.contains("5 hours Remaining 99%"));
        assert!(tooltip(&weekly_only, "zh", preferred).contains("状态栏: 每周 剩余 99%"));
    }

    #[test]
    fn preferred_weekly_window_falls_back_to_five_hour_without_hiding_real_zero() {
        let mut snapshot = account_quota(Some(0.0), None);
        snapshot.status = TrayQuotaStatus::Stale;
        let (kind, window) = selected_window(&snapshot, TrayQuotaWindow::SevenDay).unwrap();
        assert_eq!(kind, TrayQuotaWindow::FiveHour);
        assert_eq!(remaining_text(Some(window.remaining), true), "~0%");
        assert!(tooltip(&snapshot, "en", TrayQuotaWindow::SevenDay)
            .contains("Menu bar: 5 hours Remaining ~0%"));
    }

    #[test]
    fn unavailable_or_invalid_accounts_never_fall_back_to_old_values() {
        for preferred in [TrayQuotaWindow::FiveHour, TrayQuotaWindow::SevenDay] {
            assert!(selected_window(&account_quota(None, None), preferred).is_none());
            for status in [
                TrayQuotaStatus::Unavailable,
                TrayQuotaStatus::Expired,
                TrayQuotaStatus::Unsupported,
            ] {
                let mut snapshot = account_quota(Some(45.0), Some(91.0));
                snapshot.status = status;
                assert!(selected_window(&snapshot, preferred).is_none());
            }
        }
    }

    #[test]
    fn quota_labels_preserve_unknown_zero_and_full_boundaries() {
        for (value, expected) in [
            (None, "—"),
            (Some(f64::NAN), "—"),
            (Some(-1.0), "—"),
            (Some(101.0), "—"),
            (Some(0.0), "0%"),
            (Some(0.1), "<1%"),
            (Some(36.0), "36%"),
            (Some(99.8), "99%"),
            (Some(100.0), "100%"),
        ] {
            assert_eq!(remaining_text(value, false), expected);
        }
        assert_eq!(remaining_text(Some(36.0), true), "~36%");
        assert_eq!(remaining_text(None, true), "—");
    }

    #[test]
    fn ring_thresholds_follow_settings_without_coloring_stale_values() {
        let settings = AppSettings::default();
        assert_eq!(ring_tone(Some(50.0), false, &settings), RingTone::Warning);
        assert_eq!(ring_tone(Some(10.0), false, &settings), RingTone::Low);
        assert_eq!(ring_tone(Some(75.0), false, &settings), RingTone::System);
        assert_eq!(ring_tone(Some(5.0), true, &settings), RingTone::System);
    }

    #[test]
    fn native_raster_has_transparent_margin_and_distinct_unknown_zero_full_states() {
        let full = ring_rgba(Some(100.0), RingTone::System);
        let zero = ring_rgba(Some(0.0), RingTone::System);
        let unknown = ring_rgba(None, RingTone::System);
        assert_eq!(full.len(), 54 * 54 * 4);
        assert!(full[..54 * 4].iter().all(|v| *v == 0));
        assert_eq!(full[(27 * 54 + 27) * 4 + 3], 0);
        let alpha = |p: &[u8]| p.chunks_exact(4).map(|p| p[3] as u32).sum::<u32>();
        assert!(alpha(&full) > alpha(&zero));
        assert_ne!(unknown, zero);
    }
}
