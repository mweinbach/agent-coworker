//! Experiments / Feature Flags settings page (`apps/desktop/src/ui/settings/pages/FeatureFlagsPage.tsx`).

use std::collections::BTreeSet;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use rune::{El, memo, row, text};
use rune_kit::Kit;

use crate::actions::{Action, SettingsAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, mini_switch, settings_page, status_pill,
    theme_memo_sig,
};
use crate::views::settings::shell::PageContent;

/// Metadata for a known desktop feature flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeatureFlagMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub default_enabled: bool,
    pub restart_required: bool,
    pub packaged_forced_off: bool,
}

/// Canonical feature flags matching `src/shared/featureFlags.ts`.
pub const KNOWN_FEATURE_FLAGS: &[FeatureFlagMeta] = &[
    FeatureFlagMeta {
        id: "menuBar",
        label: "Menu bar / tray",
        description: "Show a quick-access Cowork status item in the OS menu bar or tray.",
        default_enabled: true,
        restart_required: false,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "remoteAccess",
        label: "Remote access",
        description: "Enable phone pairing and relay access while the desktop app is open.",
        default_enabled: false,
        restart_required: true,
        packaged_forced_off: true,
    },
    FeatureFlagMeta {
        id: "workspacePicker",
        label: "Workspace picker",
        description: "Expose the workspace selector control across header and sidebar surfaces.",
        default_enabled: true,
        restart_required: false,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "workspaceLifecycle",
        label: "Workspace lifecycle actions",
        description: "Enable stop, restart, and server process controls for local workspaces.",
        default_enabled: true,
        restart_required: false,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "openAiNativeConnectors",
        label: "OpenAI native connectors",
        description: "Enable the OpenAI Native Connectors settings view and Codex apps tooling.",
        default_enabled: false,
        restart_required: true,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "canvas",
        label: "Canvas",
        description: "Allow interactive workspace canvas artifacts inside threads.",
        default_enabled: false,
        restart_required: false,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "tasks",
        label: "Tasks",
        description: "Show background scheduled tasks navigation and detail views.",
        default_enabled: false,
        restart_required: true,
        packaged_forced_off: false,
    },
    FeatureFlagMeta {
        id: "workflows",
        label: "Workflows",
        description: "Enable multi-step workflow execution and run inspection.",
        default_enabled: false,
        restart_required: true,
        packaged_forced_off: false,
    },
];

/// Resolves whether `flag_id` is currently enabled given `s.feature_flags` and `s.is_packaged`.
pub fn resolve_flag_enabled(s: &AppState, meta: &FeatureFlagMeta) -> bool {
    if s.is_packaged {
        if meta.packaged_forced_off {
            return false;
        }
        return meta.default_enabled;
    }
    s.feature_flags
        .get(meta.id)
        .copied()
        .unwrap_or(meta.default_enabled)
}

/// Resolves whether any desktop feature flag ID is active using `KNOWN_FEATURE_FLAGS` defaults.
pub fn is_flag_enabled(s: &AppState, flag_id: &str) -> bool {
    if let Some(meta) = KNOWN_FEATURE_FLAGS.iter().find(|f| f.id == flag_id) {
        resolve_flag_enabled(s, meta)
    } else if s.is_packaged {
        false
    } else {
        s.feature_flags.get(flag_id).copied().unwrap_or(false)
    }
}

struct FlagRowSpec<'a> {
    id: String,
    label: &'a str,
    description: &'a str,
    enabled: bool,
    overridden: bool,
    restart_required: bool,
    disabled: bool,
    packaged_forced_off: bool,
}

fn render_flag_row(spec: FlagRowSpec<'_>, k: &Kit, t: &ThemeTokens) -> El {
    let mut meta_parts: Vec<El> = Vec::new();
    if spec.packaged_forced_off {
        meta_parts.push(status_pill(
            "Disabled in packaged builds",
            StatusTone::Neutral,
            k,
            t,
        ));
    }
    if spec.restart_required {
        meta_parts.push(status_pill("Restart required", StatusTone::Warning, k, t));
    }
    if spec.overridden {
        meta_parts.push(status_pill("Override active", StatusTone::Neutral, k, t));
    }

    let enabled = spec.enabled;
    let toggle_id = spec.id.clone();
    let toggle = mini_switch(
        enabled,
        spec.label,
        spec.disabled,
        move |s: &mut AppState| {
            let next = !enabled;
            s.dispatch(Action::Settings(SettingsAction::SetFeatureFlag {
                flag_id: toggle_id.clone(),
                enabled: next,
            }));
        },
        k,
    );

    let control = row()
        .items_center()
        .gap(10.0)
        .children(meta_parts)
        .child(toggle);

    SettingsRow::new(spec.label)
        .description(spec.description)
        .meta(format!("Flag key: {}", spec.id))
        .control(control)
        .build(k, t)
}

/// Renders the Experiments (Feature Flags) settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let mut h = DefaultHasher::new();
    (theme_memo_sig(s, t), s.is_packaged).hash(&mut h);
    let mut flags_acc = 0u64;
    for (fk, fv) in &s.feature_flags {
        let mut fh = DefaultHasher::new();
        (fk.as_str(), *fv).hash(&mut fh);
        flags_acc = flags_acc.wrapping_add(fh.finish());
    }
    let mut ov_acc = 0u64;
    for (ok, ov) in &s.feature_flag_overrides {
        let mut oh = DefaultHasher::new();
        (ok.as_str(), *ov).hash(&mut oh);
        ov_acc = ov_acc.wrapping_add(oh.finish());
    }
    (
        s.feature_flags.len(),
        flags_acc,
        s.feature_flag_overrides.len(),
        ov_acc,
    )
        .hash(&mut h);

    let body = memo("settings-experiments-body", h.finish(), || {
        let banner = callout_banner(
            StatusTone::Neutral,
            "Experimental flags change desktop surface availability. Flags marked Restart required take full effect after relaunch.",
            k,
            t,
        );

        let known_rows: Vec<El> = KNOWN_FEATURE_FLAGS
            .iter()
            .map(|meta| {
                let overridden = !s.is_packaged && s.feature_flag_overrides.contains_key(meta.id);
                let enabled = resolve_flag_enabled(s, meta);
                let packaged_forced_off = s.is_packaged && meta.packaged_forced_off;
                render_flag_row(
                    FlagRowSpec {
                        id: meta.id.to_string(),
                        label: meta.label,
                        description: meta.description,
                        enabled,
                        overridden,
                        restart_required: meta.restart_required,
                        disabled: packaged_forced_off || s.is_packaged,
                        packaged_forced_off,
                    },
                    k,
                    t,
                )
            })
            .collect();

        let known_ids: BTreeSet<&str> = KNOWN_FEATURE_FLAGS.iter().map(|f| f.id).collect();
        let extra_keys: BTreeSet<String> = s
            .feature_flags
            .keys()
            .filter(|id| !known_ids.contains(id.as_str()))
            .cloned()
            .collect();

        let mut sections = vec![
            banner,
            Section::new()
                .title("Feature flags")
                .description("Toggle pre-release capabilities for this local Cowork installation.")
                .children(known_rows)
                .build(k, t),
        ];

        if !extra_keys.is_empty() && !s.is_packaged {
            let extra_rows: Vec<El> = extra_keys
                .into_iter()
                .map(|key| {
                    let enabled = s.feature_flags.get(&key).copied().unwrap_or(false);
                    render_flag_row(
                        FlagRowSpec {
                            id: key.clone(),
                            label: &key,
                            description: "Custom flag loaded from persisted desktop state.",
                            enabled,
                            overridden: true,
                            restart_required: false,
                            disabled: false,
                            packaged_forced_off: false,
                        },
                        k,
                        t,
                    )
                })
                .collect();
            sections.push(
                Section::new()
                    .title("Custom flags")
                    .description("Additional feature keys present in local desktop configuration.")
                    .children(extra_rows)
                    .build(k, t),
            );
        } else {
            sections.push(
                rune::el().child(
                    text(format!(
                        "{} experimental flags configured",
                        KNOWN_FEATURE_FLAGS.len()
                    ))
                    .font(k.ty.small)
                    .color(t.text_faint),
                ),
            );
        }

        settings_page(sections)
    });

    PageContent::simple(body)
}
