//! macOS menu-bar presentation. Quota identity and freshness live in tray_quota.

#[cfg(target_os = "macos")]
use crate::settings::TrayDisplayMode;
#[cfg(any(test, target_os = "macos"))]
use crate::settings::{AppSettings, TrayQuotaColorMode, TrayQuotaWindow};
#[cfg(any(test, target_os = "macos"))]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg(any(test, target_os = "macos"))]
enum RingTone {
    System,
    Warning,
    Low,
}

#[cfg(any(test, target_os = "macos"))]
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
    const SIZE: usize = 54;
    const SAMPLES: usize = 4;
    let foreground = match tone {
        RingTone::System => [0, 0, 0],
        RingTone::Warning => [213, 142, 0],
        RingTone::Low => [218, 58, 70],
    };
    let track = if tone == RingTone::System {
        [0, 0, 0]
    } else {
        [128, 128, 128]
    };
    let fraction = value.map(|v| v.clamp(0.0, 100.0) / 100.0);
    let mut pixels = vec![0; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut premultiplied = [0.0; 3];
            let mut alpha = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let dx = x as f64 + (sx as f64 + 0.5) / SAMPLES as f64 - 27.0;
                    let dy = y as f64 + (sy as f64 + 0.5) / SAMPLES as f64 - 27.0;
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
            let index = (y * SIZE + x) * 4;
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

#[cfg(any(test, target_os = "macos"))]
struct Labels {
    menu_bar: &'static str,
    remaining: &'static str,
    five_hour: &'static str,
    seven_day: &'static str,
    reset: &'static str,
    updated: &'static str,
    stale: &'static str,
    unavailable: &'static str,
    expired: &'static str,
    disabled: &'static str,
    unsupported: &'static str,
}

#[cfg(any(test, target_os = "macos"))]
fn labels(language: &str) -> Labels {
    match language {
        "en" => Labels {
            menu_bar: "Menu bar",
            remaining: "Remaining",
            five_hour: "5 hours",
            seven_day: "Weekly",
            reset: "Resets",
            updated: "Updated",
            stale: "Refresh failed · last known quota",
            unavailable: "Quota unavailable",
            expired: "Sign in again",
            disabled: "Quota queries disabled",
            unsupported: "This connection has no supported subscription quota",
        },
        "ja" => Labels {
            menu_bar: "メニューバー",
            remaining: "残り",
            five_hour: "5 時間",
            seven_day: "週間",
            reset: "リセット",
            updated: "更新",
            stale: "更新失敗 · 前回の残量",
            unavailable: "残量を取得できません",
            expired: "再ログインしてください",
            disabled: "残量の照会は無効です",
            unsupported: "この接続のサブスクリプション残量には対応していません",
        },
        "zh-TW" => Labels {
            menu_bar: "狀態列",
            remaining: "剩餘",
            five_hour: "5 小時",
            seven_day: "每週",
            reset: "重置",
            updated: "更新",
            stale: "重新整理失敗 · 上次額度",
            unavailable: "額度暫不可用",
            expired: "登入已失效，請重新登入",
            disabled: "已停用額度查詢",
            unsupported: "目前連線不支援訂閱額度",
        },
        _ => Labels {
            menu_bar: "状态栏",
            remaining: "剩余",
            five_hour: "5 小时",
            seven_day: "每周",
            reset: "重置",
            updated: "更新",
            stale: "刷新失败 · 上次额度",
            unavailable: "额度暂不可用",
            expired: "登录已失效，请重新登录",
            disabled: "已停用额度查询",
            unsupported: "当前连接不支持订阅额度",
        },
    }
}

#[cfg(any(test, target_os = "macos"))]
fn window_line(
    label: &str,
    window: Option<&TrayQuotaWindowSnapshot>,
    stale: bool,
    text: &Labels,
) -> String {
    let value = remaining_text(window.map(|w| w.remaining), stale);
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
#[cfg(any(test, target_os = "macos"))]
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
    let text = labels(language);
    let mut lines = vec!["Codex Switch".to_owned()];
    if let Some(label) = &snapshot.account_label {
        // Keep account remarks to one tooltip line; don't leak credentials or raw errors.
        lines.push(label.replace(['\n', '\r'], " "));
    }
    let stale = snapshot.status == TrayQuotaStatus::Stale;
    let selected = selected_window(snapshot, preferred);
    if let Some((kind, window)) = selected {
        let label = match kind {
            TrayQuotaWindow::FiveHour => text.five_hour,
            TrayQuotaWindow::SevenDay => text.seven_day,
        };
        lines.push(format!(
            "{}: {}",
            text.menu_bar,
            window_line(label, Some(window), stale, &text)
        ));
    }
    // Include the other window, including an unavailable preferred window, so
    // the tooltip identifies the fallback without suggesting both limits exist.
    if selected.is_none_or(|(kind, _)| kind != TrayQuotaWindow::FiveHour) {
        lines.push(window_line(
            text.five_hour,
            snapshot.five_hour.as_ref(),
            stale,
            &text,
        ));
    }
    if selected.is_none_or(|(kind, _)| kind != TrayQuotaWindow::SevenDay) {
        lines.push(window_line(
            text.seven_day,
            snapshot.seven_day.as_ref(),
            stale,
            &text,
        ));
    }
    let status = match snapshot.status {
        TrayQuotaStatus::Ready => None,
        TrayQuotaStatus::Stale => Some(text.stale),
        TrayQuotaStatus::Unavailable => Some(text.unavailable),
        TrayQuotaStatus::Expired => Some(text.expired),
        TrayQuotaStatus::Disabled => Some(text.disabled),
        TrayQuotaStatus::Unsupported => Some(text.unsupported),
    };
    if let Some(status) = status {
        lines.push(status.to_owned());
    }
    if let Some(at) = snapshot
        .updated_at
        .and_then(chrono::DateTime::from_timestamp_millis)
    {
        lines.push(format!(
            "{} {}",
            text.updated,
            at.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S")
        ));
    }
    lines.join("\n")
}

#[cfg(target_os = "macos")]
static DISPLAY_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "macos")]
pub(crate) fn update(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let revision = DISPLAY_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // DB/config/auth source reads never block AppKit event processing.
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

#[cfg(not(target_os = "macos"))]
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
                TrayQuotaStatus::Disabled,
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
