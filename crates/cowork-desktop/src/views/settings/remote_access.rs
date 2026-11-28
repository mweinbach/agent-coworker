//! Remote Access settings page (`apps/desktop/src/ui/settings/pages/RemoteAccessPage.tsx`).

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use qrcode::{Color as QrColor, QrCode};
use rune::{Color, El, Pixels, col, el, icon, memo, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::{Map, Value};

use crate::actions::{Action, NativeAction, SettingsAction};
use crate::state::{AppState, TrustedPhoneSummary};
use crate::theme::ThemeTokens;
use crate::views::settings::experiments::is_flag_enabled;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, callout_banner,
    confirm_dialog, find_management_target, format_timestamp_friendly, management_targets,
    mini_switch, settings_page, status_pill, theme_memo_sig,
};
use crate::views::settings::shell::PageContent;

/// Canonical permission keys exposed on paired Cowork Mobile devices.
const PERMISSION_CONTROLS: &[(&str, &str)] = &[
    ("conversations", "Conversations"),
    ("turns", "Turns"),
    ("serverRequests", "Approvals"),
    ("providerAuth", "Provider auth"),
    ("mcpAuth", "MCP auth"),
    ("workspaceSettings", "Workspace settings"),
    ("backups", "Backups"),
];

const MAX_PHONE_PERMS_CACHE: usize = 64;

thread_local! {
    static QR_PIXEL_CACHE: RefCell<Option<(String, Pixels)>> = const { RefCell::new(None) };
    static PHONE_PERMS_CACHE: RefCell<HashMap<String, Arc<HashSet<String>>>> =
        RefCell::new(HashMap::new());
}

fn cached_phone_permissions(raw: &str) -> Arc<HashSet<String>> {
    PHONE_PERMS_CACHE.with(|slot| {
        let mut cache = slot.borrow_mut();
        if let Some(existing) = cache.get(raw) {
            return Arc::clone(existing);
        }
        let parsed = Arc::new(parse_phone_permissions(raw));
        if cache.len() >= MAX_PHONE_PERMS_CACHE {
            cache.clear();
        }
        cache.insert(raw.to_string(), Arc::clone(&parsed));
        parsed
    })
}

fn qr_pixels_for_url(url: &str) -> Option<Pixels> {
    let key = url.trim();
    if key.is_empty() {
        return None;
    }
    QR_PIXEL_CACHE.with(|cache| {
        let mut slot = cache.borrow_mut();
        if let Some((cached_url, px)) = slot.as_ref()
            && cached_url == key
        {
            return Some(px.clone());
        }
        let code = QrCode::new(key.as_bytes()).ok()?;
        let modules = code.width();
        let quiet = 4usize;
        let total_mods = modules + quiet * 2;
        let target_px = 220usize;
        let scale = (target_px / total_mods).max(2);
        let size = total_mods * scale;
        let mut rgba = vec![255u8; size * size * 4];

        for my in 0..modules {
            for mx in 0..modules {
                if matches!(code[(mx, my)], QrColor::Dark) {
                    let px_x = (mx + quiet) * scale;
                    let px_y = (my + quiet) * scale;
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let idx = ((px_y + dy) * size + (px_x + dx)) * 4;
                            rgba[idx] = 0;
                            rgba[idx + 1] = 0;
                            rgba[idx + 2] = 0;
                            rgba[idx + 3] = 255;
                        }
                    }
                }
            }
        }

        let px = Pixels::new();
        px.set(size as u32, size as u32, rgba);
        *slot = Some((key.to_string(), px.clone()));
        Some(px)
    })
}

/// Parses a paired device's `permissions` string (JSON map, sentinel, or CSV) into enabled keys.
pub fn parse_phone_permissions(raw: &str) -> HashSet<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return HashSet::new();
    }
    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(trimmed) {
        return obj
            .into_iter()
            .filter_map(|(k, v)| v.as_bool().filter(|enabled| *enabled).map(|_| k))
            .collect();
    }
    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "none" | "read-only" | "readonly") {
        return HashSet::new();
    }
    if matches!(lower.as_str(), "all" | "full" | "read-write") {
        return PERMISSION_CONTROLS
            .iter()
            .map(|(k, _)| (*k).to_string())
            .collect();
    }
    trimmed
        .split([',', ' ', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Serializes toggled device permissions cleanly while matching `native::remote_access` patch syntax.
pub fn update_phone_permission_string(raw: &str, key: &str, enabled: bool) -> String {
    let trimmed = raw.trim();
    if let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(trimmed) {
        obj.insert(key.to_string(), Value::Bool(enabled));
        return Value::Object(obj).to_string();
    }
    let mut keys = parse_phone_permissions(trimmed);
    if enabled {
        keys.insert(key.to_string());
    } else {
        keys.remove(key);
    }
    if trimmed.is_empty() {
        let mut obj = Map::new();
        for (perm_key, _) in PERMISSION_CONTROLS {
            obj.insert(
                (*perm_key).to_string(),
                Value::Bool(keys.contains(*perm_key)),
            );
        }
        return Value::Object(obj).to_string();
    }
    let mut ordered: Vec<String> = keys.into_iter().collect();
    ordered.sort();
    if ordered.is_empty() {
        "none".to_string()
    } else {
        ordered.join(",")
    }
}

fn device_card(device: &TrustedPhoneSummary, k: &Kit, t: &ThemeTokens) -> El {
    let enabled_perms = cached_phone_permissions(&device.permissions);
    let device_id = device.id.clone();
    let device_id_forget = device.id.clone();

    let header = row()
        .w_full()
        .justify_between()
        .items_start()
        .gap(12.0)
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(4.0)
                .child(
                    row()
                        .items_center()
                        .gap(8.0)
                        .child(icon(&icons::SMARTPHONE, 15.0).color(t.text_base))
                        .child(
                            text(if device.name.trim().is_empty() {
                                "Paired mobile device"
                            } else {
                                device.name.trim()
                            })
                            .font(k.ty.ui_medium)
                            .color(t.text_base),
                        ),
                )
                .child(
                    text(format!("Device ID: {device_id}"))
                        .font(t.code)
                        .color(t.text_muted),
                )
                .child(
                    text(format!(
                        "Paired: {}",
                        format_timestamp_friendly(device.paired_at)
                    ))
                    .font(k.ty.small)
                    .color(t.text_muted),
                ),
        )
        .child(
            Button::new("Forget")
                .variant(ButtonVariant::Danger)
                .icon(&icons::TRASH)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut AppState| {
                    s.settings_ui.forget_phone_id = Some(device_id_forget.clone());
                })
                .build(k),
        );

    let mut perm_rows = col().w_full().gap(8.0).pt(10.0);
    perm_rows = perm_rows.child(
        text("Permissions")
            .font(k.ty.small_medium)
            .color(t.text_muted),
    );

    for &(perm_key, perm_label) in PERMISSION_CONTROLS {
        let checked = enabled_perms.contains(perm_key);
        let pid = device.id.clone();
        perm_rows = perm_rows.child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(12.0)
                .child(text(perm_label).font(k.ty.small).color(t.text_muted))
                .child(mini_switch(
                    checked,
                    perm_label,
                    false,
                    move |s: &mut AppState| {
                        let raw_perms = s
                            .remote_access
                            .trusted_phones
                            .iter()
                            .find(|p| p.id == pid)
                            .map(|p| p.permissions.as_str())
                            .unwrap_or("");
                        let next_perms =
                            update_phone_permission_string(raw_perms, perm_key, !checked);
                        s.dispatch(Action::Settings(
                            SettingsAction::UpdateTrustedPhonePermissions {
                                phone_id: pid.clone(),
                                permissions: next_perms,
                            },
                        ));
                    },
                    k,
                )),
        );
    }

    col()
        .w_full()
        .px(16.0)
        .py(14.0)
        .gap(8.0)
        .child(header)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(perm_rows)
}

/// Renders the Remote Access settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let ra = &s.remote_access;
    let flag_enabled = is_flag_enabled(s, "remoteAccess");
    let targets = management_targets(s);
    let active_ws = find_management_target(s, &targets, s.resolve_management_workspace_id());

    let toggle_btn = Button::new(if ra.running {
        "Stop"
    } else {
        "Enable remote access"
    })
    .variant(if ra.running {
        ButtonVariant::Outline
    } else {
        ButtonVariant::Submit
    })
    .icon(&icons::WIFI)
    .control_size(ControlSize::Regular)
    .disabled(!ra.available || !flag_enabled || active_ws.is_none())
    .on_press(|s: &mut AppState| {
        let next = !s.remote_access.running;
        s.dispatch(Action::Settings(SettingsAction::SetRemoteAccessEnabled(
            next,
        )));
    })
    .build(k);

    let rotate_btn = Button::new("Rotate QR / certificate")
        .variant(ButtonVariant::Outline)
        .icon(&icons::REFRESH_CCW)
        .control_size(ControlSize::Regular)
        .disabled(!ra.running)
        .on_press(|s: &mut AppState| {
            s.dispatch(Action::Settings(SettingsAction::RotateRemoteAccessSession));
        })
        .build(k);

    let header_actions = vec![toggle_btn, rotate_btn];

    let mut body_h = DefaultHasher::new();
    (
        theme_memo_sig(s, t),
        flag_enabled,
        active_ws.map(|w| (w.id.as_str(), w.label.as_str(), w.path.as_str())),
        ra.available,
        ra.running,
        ra.error.as_deref(),
        ra.relay_url.as_deref(),
        ra.pairing_url.as_deref(),
        s.settings_ui.remote_access_copied_url.as_deref(),
        ra.trusted_phones.len(),
    )
        .hash(&mut body_h);
    for phone in &ra.trusted_phones {
        (
            phone.id.as_str(),
            phone.name.as_str(),
            phone.permissions.as_str(),
            phone.paired_at,
        )
            .hash(&mut body_h);
    }

    let body = memo("settings-remote-access-body", body_h.finish(), || {
        let mut blocks: Vec<El> = Vec::new();
        if !flag_enabled {
            blocks.push(callout_banner(
                StatusTone::Warning,
                "Remote Access is disabled in this build configuration.",
                k,
                t,
            ));
        }
        if let Some(err) = ra.error.as_deref().filter(|msg| !msg.trim().is_empty()) {
            blocks.push(callout_banner(StatusTone::Danger, err, k, t));
        }

        let status_pill_el = if !ra.available {
            status_pill("Unavailable", StatusTone::Warning, k, t)
        } else if ra.running {
            status_pill("Running", StatusTone::Success, k, t)
        } else {
            status_pill("Idle", StatusTone::Neutral, k, t)
        };

        let ws_name = active_ws
            .map(|w| w.label.as_str())
            .unwrap_or("No workspace selected");
        let ws_path = active_ws
            .map(|w| w.path.as_str())
            .unwrap_or("Select or add a workspace before starting the mobile bridge.");

        let mut bridge_section = Section::new()
            .title("Workspace bridge")
            .description("Expose a single workspace through blind TLS relay while desktop runs.")
            .action(status_pill_el)
            .child(SettingsRow::new(ws_name).description(ws_path).build(k, t));

        if let Some(relay_url) = ra.relay_url.as_deref().filter(|u| !u.trim().is_empty()) {
            bridge_section = bridge_section.child(
                SettingsRow::new("Relay endpoint")
                    .description(relay_url)
                    .build(k, t),
            );
        }

        blocks.push(bridge_section.build(k, t));

        let qr_body = if let Some(url) = ra.pairing_url.as_deref().filter(|u| !u.trim().is_empty())
        {
            let url_owned = url.to_string();
            let mut qr_col = col().w_full().items_center().gap(14.0).py(12.0);
            if let Some(px) = qr_pixels_for_url(url) {
                qr_col = qr_col.child(
                    el().px(10.0)
                        .py(10.0)
                        .radius(k.radius.lg)
                        .fill(Color::WHITE)
                        .border(1.0, t.border)
                        .child(el().w(200.0).h(200.0).pixels(&px)),
                );
            }
            let copied = s.settings_ui.remote_access_copied_url.as_deref() == Some(url);
            qr_col = qr_col.child(
                row().w_full().min_w(0.0).gap(8.0).flex_wrap().child(
                    Button::new(if copied {
                        "Pairing key copied"
                    } else {
                        "Copy pairing key"
                    })
                    .variant(ButtonVariant::Outline)
                    .icon(&icons::COPY)
                    .control_size(ControlSize::Regular)
                    .on_press(move |s: &mut AppState| {
                        s.settings_ui.remote_access_copied_url = Some(url_owned.clone());
                        s.dispatch(Action::Native(NativeAction::CopyText(url_owned.clone())));
                    })
                    .build(k),
                ),
            );
            qr_col
        } else {
            EmptyState::new("Enable remote access to generate a pairing QR")
                .icon(&icons::QR_CODE)
                .description("Once the bridge is running, scan the QR code from Cowork Mobile.")
                .build(k, t)
        };

        let qr_section = Section::new()
            .title("Pairing QR")
            .description("Scan this QR code from Cowork Mobile or copy the pairing key manually.")
            .child(el().w_full().px(16.0).py(12.0).child(qr_body))
            .build(k, t);

        let mut devices_section = Section::new().title("Trusted devices").description(
            "Trust is scoped to this workspace. Revoked phones lose access immediately.",
        );

        if !ra.trusted_phones.is_empty() {
            devices_section = devices_section.action(
                Button::new("Forget all devices")
                    .variant(ButtonVariant::Danger)
                    .icon(&icons::TRASH)
                    .control_size(ControlSize::Small)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.forget_all_phones_open = true;
                    })
                    .build(k),
            );
            for phone in &ra.trusted_phones {
                devices_section = devices_section.child(device_card(phone, k, t));
            }
        } else {
            devices_section = devices_section.child(
                EmptyState::new("No trusted device yet")
                    .icon(&icons::SMARTPHONE)
                    .description("Scan the pairing QR to connect your first mobile device.")
                    .build(k, t),
            );
        }

        blocks.push(
            row()
                .w_full()
                .items_start()
                .gap(16.0)
                .child(col().grow(1.0).min_w(0.0).child(qr_section))
                .child(
                    col()
                        .w(380.0)
                        .min_w(320.0)
                        .child(devices_section.build(k, t)),
                ),
        );

        settings_page(blocks)
    });

    let mut overlays = Vec::new();
    if let Some(forget_id) = s.settings_ui.forget_phone_id.as_deref() {
        let forget_target_name = ra
            .trusted_phones
            .iter()
            .find(|p| p.id == forget_id)
            .map(|p| {
                if p.name.trim().is_empty() {
                    p.id.as_str()
                } else {
                    p.name.trim()
                }
            })
            .unwrap_or("this device");

        confirm_dialog(
            ConfirmDialogSpec {
                key: "remote-access-forget-device",
                open: true,
                title: "Forget trusted device?",
                description: format!(
                    "Revokes remote access for {forget_target_name}. The phone will need to scan a new QR code before it can reconnect."
                ),
                confirm_label: "Forget device",
                danger: true,
            },
            |s| {
                s.settings_ui.forget_phone_id = None;
            },
            |s| {
                if let Some(phone_id) = s.settings_ui.forget_phone_id.take() {
                    s.dispatch(Action::Settings(SettingsAction::ForgetTrustedPhone {
                        phone_id,
                    }));
                }
            },
            k,
            &mut overlays,
        );
    }

    if s.settings_ui.forget_all_phones_open {
        confirm_dialog(
            ConfirmDialogSpec {
                key: "remote-access-forget-all",
                open: true,
                title: "Forget all trusted devices?",
                description: format!(
                    "Revokes remote access for all {} trusted phone(s). Each phone must scan a new QR code to reconnect.",
                    ra.trusted_phones.len()
                ),
                confirm_label: "Forget all devices",
                danger: true,
            },
            |s| {
                s.settings_ui.forget_all_phones_open = false;
            },
            |s| {
                s.settings_ui.forget_all_phones_open = false;
                s.dispatch(Action::Settings(SettingsAction::RevokeAllTrustedPhones));
            },
            k,
            &mut overlays,
        );
    }

    PageContent::simple(body)
        .with_header_actions(header_actions)
        .with_overlays(overlays)
}
