//! Experiments / Feature Flags settings page (`apps/desktop/src/ui/settings/pages/FeatureFlagsPage.tsx`).

use std::collections::BTreeSet;

use rune::{El, row, text};
use rune_kit::{Kit, Switch};

use crate::actions::{Action, SettingsAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    Section, SettingsRow, StatusTone, callout_banner, settings_page, status_pill,
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
}

/// Canonical feature flags matching `src/shared/featureFlags.ts`.
pub const KNOWN_FEATURE_FLAGS: &[FeatureFlagMeta] = &[
    FeatureFlagMeta {
        id: "menuBar",
        label: "Menu bar / tray",
        description: "Show a quick-access Cowork status item in the OS menu bar or tray.",
        default_enabled: true,
        restart_required: false,
    },
    FeatureFlagMeta {
        id: "remoteAccess",
        label: "Remote access",
        description: "Enable phone pairing and relay access while the desktop app is open.",
        default_enabled: false,
        restart_required: true,
    },
    FeatureFlagMeta {
        id: "workspacePicker",
        label: "Workspace picker",
        description: "Expose the workspace selector control across header and sidebar surfaces.",
        default_enabled: true,
        restart_required: false,
    },
    FeatureFlagMeta {
        id: "workspaceLifecycle",
        label: "Workspace lifecycle actions",
        description: "Enable stop, restart, and server process controls for local workspaces.",
        default_enabled: true,
        restart_required: false,
    },
    FeatureFlagMeta {
        id: "openAiNativeConnectors",
        label: "OpenAI native connectors",
        description: "Enable the OpenAI Native Connectors settings view and Codex apps tooling.",
        default_enabled: false,
        restart_required: true,
    },
    FeatureFlagMeta {
        id: "canvas",
        label: "Canvas",
        description: "Allow interactive workspace canvas artifacts inside threads.",
        default_enabled: false,
        restart_required: false,
    },
    FeatureFlagMeta {
        id: "tasks",
        label: "Tasks",
        description: "Show background scheduled tasks navigation and detail views.",
        default_enabled: false,
        restart_required: true,
    },
    FeatureFlagMeta {
        id: "workflows",
        label: "Workflows",
        description: "Enable multi-step workflow execution and run inspection.",
        default_enabled: false,
        restart_required: true,
    },
];

/// Resolves whether `flag_id` is currently enabled given `s.feature_flags`.
pub fn resolve_flag_enabled(s: &AppState, meta: &FeatureFlagMeta) -> bool {
    s.feature_flags
        .get(meta.id)
        .copied()
        .unwrap_or(meta.default_enabled)
}

struct FlagRowSpec<'a> {
    id: String,
    label: &'a str,
    description: &'a str,
    enabled: bool,
    overridden: bool,
    restart_required: bool,
}

fn render_flag_row(spec: FlagRowSpec<'_>, k: &Kit, t: &ThemeTokens) -> El {
    let mut meta_parts: Vec<El> = Vec::new();
    if spec.restart_required {
        meta_parts.push(status_pill("Restart required", StatusTone::Warning, k, t));
    }
    if spec.overridden {
        meta_parts.push(status_pill("Override active", StatusTone::Neutral, k, t));
    }

    let enabled = spec.enabled;
    let toggle_id = spec.id.clone();
    let toggle = Switch::new(enabled)
        .label(spec.label)
        .hide_label()
        .on_toggle(move |s: &mut AppState| {
            let next = !enabled;
            s.dispatch(Action::Settings(SettingsAction::SetFeatureFlag {
                flag_id: toggle_id.clone(),
                enabled: next,
            }));
        })
        .build(k);

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
    let banner = callout_banner(
        StatusTone::Neutral,
        "Experimental flags change desktop surface availability. Flags marked Restart required take full effect after relaunch.",
        k,
        t,
    );

    let known_rows: Vec<El> = KNOWN_FEATURE_FLAGS
        .iter()
        .map(|meta| {
            let overridden = s.feature_flags.contains_key(meta.id);
            let enabled = resolve_flag_enabled(s, meta);
            render_flag_row(
                FlagRowSpec {
                    id: meta.id.to_string(),
                    label: meta.label,
                    description: meta.description,
                    enabled,
                    overridden,
                    restart_required: meta.restart_required,
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

    if !extra_keys.is_empty() {
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
                .font(k.ty.text_xsmall)
                .color(t.text_faint),
            ),
        );
    }

    PageContent::simple(settings_page(sections))
}
