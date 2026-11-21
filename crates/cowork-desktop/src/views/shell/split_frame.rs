//! Full-bleed desktop split shell replacing inset card chrome so panes meet window edges cleanly.

use rune::{Anim, Color, Cursor, Curve, Easing, El, Phase, Spring, Transition, Tx, col, el, row};
use rune_kit::shell::{PaneState, SIDEBAR};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, Kit};

use crate::state::AppState;
use crate::theme::layout::SHELL_TOOLBAR_HEIGHT as TOOLBAR_HEIGHT;

const GRIP_WIDTH: f32 = 6.0;
const GRIP_STEP: f32 = 8.0;
const TOGGLE_SIDE: f32 = 28.0;
/// Back and forward beside the sidebar toggle (`ControlSize::Regular` icon buttons).
pub(crate) const NAV_BUTTON_SIDE: f32 = 24.0;
const CLUSTER_GAP: f32 = 2.0;
const TOOLBAR_EDGE_PAD: f32 = 12.0;
const POST_LIGHTS_GAP: f32 = 14.0;
const TOGGLE_CONTENT_GAP: f32 = 8.0;
const DOT_FADE_SECS: f32 = 0.15;

/// Horizontal toolbar mounted seamlessly at the top of the main column (`48`pt row).
pub struct ShellToolbar {
    leading: Vec<El>,
    trailing: Vec<El>,
}

impl ShellToolbar {
    /// Creates an empty toolbar band.
    pub fn new() -> Self {
        Self {
            leading: Vec::new(),
            trailing: Vec::new(),
        }
    }

    /// Appends a control or metadata element to the leading toolbar slot.
    pub fn leading(mut self, e: El) -> Self {
        self.leading.push(e);
        self
    }

    /// Appends a control or indicator element to the trailing toolbar slot.
    pub fn trailing(mut self, e: El) -> Self {
        self.trailing.push(e);
        self
    }

    fn build(self, leading_pad: f32, motion: Spring) -> El {
        row()
            .key("toolbar")
            .role("toolbar")
            .w_full()
            .h(TOOLBAR_HEIGHT)
            .pl(leading_pad)
            .pr(TOOLBAR_EDGE_PAD)
            .gap(8.0)
            .center_y()
            .window_drag()
            .motion(motion)
            .transition(Transition::none())
            .child(
                row()
                    .key("leading")
                    .gap(4.0)
                    .center_y()
                    .shrink()
                    .min_w(0.0)
                    .transition(Transition::none())
                    .children(self.leading),
            )
            .child(el().key("spacer").grow(1.0).a11y_hidden())
            .child(
                row()
                    .key("trailing")
                    .gap(4.0)
                    .center_y()
                    .transition(Transition::none())
                    .children(self.trailing),
            )
    }
}

impl Default for ShellToolbar {
    fn default() -> Self {
        Self::new()
    }
}

struct SplitPaneSpec {
    state: PaneState,
    content: El,
    padding: [f32; 2],
    dragging: bool,
    access: fn(&mut AppState) -> &mut PaneState,
    drag_start: fn(&mut AppState) -> &mut Option<f32>,
}

/// Full-bleed split window shell without inset frame padding or nested corner radii.
pub struct FullBleedSplit {
    main: El,
    toolbar: ShellToolbar,
    sidebar: Option<SplitPaneSpec>,
    inspector: Option<SplitPaneSpec>,
    titlebar_inset: f32,
    show_toggle: bool,
    unread: bool,
    toggle_shortcut: Option<String>,
    reduced_motion: bool,
    spring: Spring,
    sidebar_vibrancy: Option<f32>,
    sidebar_nav: Vec<El>,
}

impl FullBleedSplit {
    /// Creates a full-bleed split container wrapping `main`.
    pub fn new(main: El) -> Self {
        Self {
            main,
            toolbar: ShellToolbar::new(),
            sidebar: None,
            inspector: None,
            titlebar_inset: 0.0,
            show_toggle: true,
            unread: false,
            toggle_shortcut: None,
            reduced_motion: false,
            spring: Spring::new(0.3, 0.0),
            sidebar_vibrancy: None,
            sidebar_nav: Vec::new(),
        }
    }

    /// Buttons that sit beside the sidebar toggle (back and forward), in the sidebar's title
    /// bar while it is open and at the start of the toolbar while it is collapsed. The cluster
    /// never moves, so nothing jumps as the sidebar opens or closes.
    pub fn sidebar_nav(mut self, buttons: Vec<El>) -> Self {
        self.sidebar_nav = buttons;
        self
    }

    /// Backs the sidebar with the platform's vibrancy material (macOS `NSVisualEffectView`)
    /// under a tint of the sidebar colour at `tint_alpha`, so a little of the desktop shows
    /// through the window chrome. Elsewhere, and in opaque windows, the opaque sidebar fill draws.
    pub fn sidebar_vibrancy(mut self, tint_alpha: Option<f32>) -> Self {
        self.sidebar_vibrancy = tint_alpha.map(|a| a.clamp(0.0, 1.0));
        self
    }

    /// Sets the main pane's top toolbar.
    pub fn toolbar(mut self, toolbar: ShellToolbar) -> Self {
        self.toolbar = toolbar;
        self
    }

    /// Configures the collapsible leading sidebar pane.
    pub fn sidebar(
        mut self,
        state: &PaneState,
        dragging: bool,
        access: fn(&mut AppState) -> &mut PaneState,
        drag_start: fn(&mut AppState) -> &mut Option<f32>,
        content: El,
    ) -> Self {
        self.sidebar = Some(SplitPaneSpec {
            state: *state,
            content,
            padding: [0.0; 2],
            dragging,
            access,
            drag_start,
        });
        self
    }

    /// Horizontal padding applied inside the sidebar body (`[start, end]`).
    pub fn sidebar_padding(mut self, start: f32, end: f32) -> Self {
        if let Some(sb) = &mut self.sidebar {
            sb.padding = [start.max(0.0), end.max(0.0)];
        }
        self
    }

    /// Configures the collapsible trailing inspector pane.
    pub fn inspector(
        mut self,
        state: &PaneState,
        dragging: bool,
        access: fn(&mut AppState) -> &mut PaneState,
        drag_start: fn(&mut AppState) -> &mut Option<f32>,
        content: El,
    ) -> Self {
        self.inspector = Some(SplitPaneSpec {
            state: *state,
            content,
            padding: [0.0; 2],
            dragging,
            access,
            drag_start,
        });
        self
    }

    /// Sets the leading width reserved for window controls (macOS traffic lights).
    pub fn titlebar_inset(mut self, points: f32) -> Self {
        self.titlebar_inset = points.max(0.0);
        self
    }

    /// Hides the floating sidebar toggle button (used by Settings and narrow drawer layouts).
    pub fn hide_sidebar_toggle(mut self) -> Self {
        self.show_toggle = false;
        self
    }

    /// Shows an unread dot on the sidebar toggle when collapsed.
    pub fn unread(mut self, unread: bool) -> Self {
        self.unread = unread;
        self
    }

    /// Sets the tooltip shortcut label for the sidebar toggle.
    pub fn toggle_shortcut(mut self, shortcut: impl Into<String>) -> Self {
        let s = shortcut.into();
        if !s.is_empty() {
            self.toggle_shortcut = Some(s);
        }
        self
    }

    /// Disables pane open/collapse spring motion when Reduce Motion is active.
    pub fn reduced_motion(mut self, reduced: bool) -> Self {
        self.reduced_motion = reduced;
        self
    }

    /// Sets the open/collapse spring used for both pane widths and toolbar leading glide.
    pub fn spring(mut self, spring: Spring) -> Self {
        self.spring = spring;
        self
    }

    /// Builds the full-bleed split view tree.
    pub fn build(mut self, k: &Kit) -> El {
        let width_spring = if self.reduced_motion {
            Spring::NONE
        } else {
            self.spring
        };
        let fade_anim: Anim = if self.reduced_motion {
            Anim::INSTANT
        } else {
            width_spring.into()
        };

        let collapsed_toggle_x = if self.titlebar_inset > 0.0 {
            self.titlebar_inset + POST_LIGHTS_GAP
        } else {
            TOOLBAR_EDGE_PAD
        };

        let has_sidebar = self.sidebar.is_some();
        let sidebar_open = self.sidebar.as_ref().is_some_and(|sb| sb.state.is_open());
        let toggle_visible = self.show_toggle && has_sidebar;

        let nav = std::mem::take(&mut self.sidebar_nav);
        let cluster_width = TOGGLE_SIDE + nav.len() as f32 * (NAV_BUTTON_SIDE + CLUSTER_GAP);
        let floating_toggle = self.sidebar.as_ref().filter(|_| toggle_visible).map(|sb| {
            build_floating_toggle(
                k,
                sb,
                collapsed_toggle_x,
                self.unread,
                self.toggle_shortcut.as_deref(),
                nav,
            )
        });

        let toolbar_pl = if toggle_visible {
            if sidebar_open {
                TOOLBAR_EDGE_PAD
            } else {
                collapsed_toggle_x + cluster_width + TOGGLE_CONTENT_GAP
            }
        } else if has_sidebar {
            TOOLBAR_EDGE_PAD
        } else {
            collapsed_toggle_x
        };

        let vibrancy = self.sidebar_vibrancy;
        let sidebar_el = self.sidebar.map(|sb| {
            build_pane_slot(
                "sidebar-pane",
                sb,
                true,
                width_spring,
                fade_anim,
                vibrancy,
                k,
            )
        });
        let inspector_el = self.inspector.map(|insp| {
            build_pane_slot(
                "inspector-pane",
                insp,
                false,
                width_spring,
                fade_anim,
                None,
                k,
            )
        });

        let toolbar_el = self.toolbar.build(toolbar_pl, width_spring);
        let main_pane = col()
            .key("main-pane")
            .role("main")
            .grow(1.0)
            .min_w(0.0)
            .min_h(0.0)
            .h_full()
            .transition(Transition::none())
            .child(self.main.grow(1.0).min_h(0.0));

        let mut below = row()
            .key("main-row")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .motion(width_spring)
            .transition(Transition::none())
            .child(main_pane);
        if let Some(insp) = inspector_el {
            below = below.child(insp);
        }

        let main_column = col()
            .key("main-column")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .fill(k.c.bg_base)
            .motion(width_spring)
            .transition(Transition::none())
            .child(toolbar_el)
            .child(below);

        let mut split = row()
            .key("split")
            .w_full()
            .h_full()
            .motion(width_spring)
            .transition(Transition::none());
        if let Some(sb) = sidebar_el {
            split = split.child(sb);
        }

        // With a vibrant sidebar the window is transparent: leave the root unpainted so the
        // material shows, and let the main column and panes paint their own opaque fills.
        let root_fill = if vibrancy.is_some() {
            Color::TRANSPARENT
        } else {
            k.c.bg_base
        };
        let mut root = el()
            .key("shell")
            .w_full()
            .h_full()
            .fill(root_fill)
            .transition(Transition::none())
            .child(split.child(main_column));
        if let Some(toggle) = floating_toggle {
            root = root.child(toggle);
        }
        root
    }
}

fn build_floating_toggle(
    k: &Kit,
    sb: &SplitPaneSpec,
    x: f32,
    unread: bool,
    shortcut: Option<&str>,
    nav: Vec<El>,
) -> El {
    let open = sb.state.is_open();
    let access = sb.access;
    let label = if open { "Hide sidebar" } else { "Show sidebar" };
    let mut button = IconButton::new(&SIDEBAR)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Large)
        .label(label)
        .help(label);
    if let Some(sc) = shortcut {
        button = button.shortcut(sc.to_string());
    }
    let mut toggle_el = button
        .on_press(move |s: &mut AppState| {
            access(s).toggle();
        })
        .build(k)
        .expanded(open)
        .key("sidebar-toggle");

    if unread {
        let dot = el()
            .key("sidebar-toggle-unread")
            .size(7.0, 7.0)
            .radius(3.5)
            .fill(k.c.bg_accent);
        let fade = Curve::tween(DOT_FADE_SECS, Easing::EASE_IN_OUT);
        toggle_el = toggle_el.child(
            dot.absolute(TOGGLE_SIDE - 5.0, -2.0)
                .opacity(if open { 0.0 } else { 1.0 })
                .opacity_motion(fade),
        );
    }

    let y = (TOOLBAR_HEIGHT - TOGGLE_SIDE) / 2.0;
    row()
        .key("sidebar-toolbar-cluster")
        .role("toolbar")
        .label("Sidebar and navigation")
        .gap(CLUSTER_GAP)
        .center_y()
        .absolute(x, y)
        .transition(Transition::none())
        .child(toggle_el)
        .children(nav)
}

fn build_pane_slot(
    key: &'static str,
    pane: SplitPaneSpec,
    leading: bool,
    width_spring: Spring,
    fade_anim: Anim,
    vibrancy: Option<f32>,
    k: &Kit,
) -> El {
    let s = pane.state;
    let open = s.is_open();
    let w = s.width();
    let sign = if leading { 1.0 } else { -1.0 };

    let mut content_col = col()
        .key("pane-content")
        .w(w)
        .h_full()
        .pl(pane.padding[0])
        .pr(pane.padding[1])
        .transition(Transition::none());

    if leading {
        let titlebar = row()
            .key("sidebar-titlebar")
            .w_full()
            .h(TOOLBAR_HEIGHT)
            .center_y()
            .window_drag()
            .child(el().key("sidebar-titlebar-fill").grow(1.0).a11y_hidden());
        // The leading sidebar slides out under the slot's clip at full opacity instead of fading
        // to zero; `inert()` keeps collapsed content out of focus and pointer hit-testing.
        content_col = content_col
            .pin(None, Some(0.0), Some(0.0), Some(0.0))
            .motion(width_spring)
            .child(titlebar);
        if !open && !pane.dragging {
            content_col = content_col.inert();
        }
    } else {
        content_col = content_col
            .opacity(if open { 1.0 } else { 0.0 })
            .opacity_motion(fade_anim)
            .fill(k.c.bg_base)
            .pin(Some(0.0), Some(0.0), None, Some(0.0));
    }

    let mut body = content_col.child(
        col()
            .key("pane-body")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .transition(Transition::none())
            .child(pane.content.w_full().h_full()),
    );
    let divider = if leading {
        el().key("sidebar-divider")
            .pin(None, Some(0.0), Some(0.0), Some(0.0))
            .w(1.0)
            .fill(k.c.border_muted)
            .a11y_hidden()
    } else {
        el().key("inspector-divider")
            .pin(Some(0.0), Some(0.0), None, Some(0.0))
            .w(1.0)
            .fill(k.c.border_muted)
            .a11y_hidden()
    };
    body = body.child(divider);

    let mut slot = el()
        .key(key)
        .role("region")
        .label(if leading { "Sidebar" } else { "Inspector" })
        .w(s.shown_width())
        .h_full()
        .motion(width_spring)
        .transition(Transition::none())
        .clip_soft(0.0);

    if leading {
        // Keep the sidebar fill, native vibrancy material, and tint on the slot rather than on
        // the sliding content column: the slot always sits at x = 0 with opacity 1.0 and matches
        // the exact visible width on every animation frame.
        slot = slot.fill(k.c.bg_deep);
        if let Some(alpha) = vibrancy {
            slot = slot.system_material(rune::SystemMaterial::Popover).child(
                el().key("sidebar-vibrancy-tint")
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .motion(width_spring)
                    .transition(Transition::none())
                    .fill(k.c.bg_deep.alpha(alpha))
                    .a11y_hidden(),
            );
        }
    }

    slot = slot.child(body);

    if !open && !pane.dragging {
        slot = slot.a11y_hidden();
    }

    if open {
        let instant = Transition::none();
        if leading {
            slot = slot
                .child(
                    el().key("pane-open-main")
                        .size(0.0, 0.0)
                        .a11y_hidden()
                        .transition(instant)
                        .focus_return("main-column"),
                )
                .child(
                    el().key("pane-open")
                        .size(0.0, 0.0)
                        .a11y_hidden()
                        .transition(instant)
                        .focus_return("sidebar-toggle"),
                );
        } else {
            slot = slot
                .child(
                    el().key("pane-open")
                        .size(0.0, 0.0)
                        .a11y_hidden()
                        .transition(instant)
                        .focus_return("sidebar-toggle"),
                )
                .child(
                    el().key("pane-open-main")
                        .size(0.0, 0.0)
                        .a11y_hidden()
                        .transition(instant)
                        .focus_return("main-pane"),
                );
        }
    }

    if open || pane.dragging {
        let access = pane.access;
        let drag_start = pane.drag_start;
        let mut grip = el()
            .key(if leading {
                "sidebar-grip"
            } else {
                "inspector-grip"
            })
            .role("separator")
            .label(if leading {
                "Resize sidebar"
            } else {
                "Resize inspector"
            })
            .range_value(
                f64::from(s.width()),
                f64::from(s.min_width()),
                f64::from(s.max_width()),
            )
            .range_step(f64::from(GRIP_STEP))
            .w(GRIP_WIDTH)
            .cursor(Cursor::ResizeColumn)
            .fill(Color::TRANSPARENT)
            .opacity(0.02)
            .transition(Transition::none())
            .focusable(false)
            .on_drag(move |app: &mut AppState, d, tx: &mut Tx| match d.phase {
                Phase::Down => {
                    let w = (access)(app).width();
                    *(drag_start)(app) = Some(w);
                }
                Phase::Move => {
                    tx.instant();
                    if let Some(start) = *(drag_start)(app) {
                        (access)(app).drag_to(start + sign * d.dx);
                    }
                }
                Phase::Up => {
                    if d.cancelled()
                        && let Some(start) = *(drag_start)(app)
                    {
                        let p = (access)(app);
                        p.set_open(true);
                        p.set_width(start);
                    }
                    *(drag_start)(app) = None;
                }
            })
            .on_double_press(move |app: &mut AppState| {
                (access)(app).reset_width();
            })
            .on_step(move |app: &mut AppState, steps, _| {
                let p = (access)(app);
                p.set_width(p.width() + steps as f32 * GRIP_STEP);
            });

        grip = if leading {
            grip.pin(None, Some(0.0), Some(0.0), Some(0.0))
        } else {
            grip.pin(Some(0.0), Some(0.0), None, Some(0.0))
        };
        slot = slot.child(grip);
    }

    slot
}

#[cfg(test)]
mod tests {
    use rune::{Cx, Env, Runtime};

    use crate::state::AppState;
    use crate::theme;

    fn shell_test_root(state: &AppState, cx: &mut Cx<AppState>) -> rune::El {
        cx.zoom(state.ui_scale);
        let dark = state.effective_dark(cx.system_dark());
        let (kit, tokens) = theme::build_kit_with_accent(
            dark,
            state.desktop_settings.reduced_transparency,
            state.desktop_settings.high_contrast,
            state.desktop_settings.accent_palette,
        );
        cx.foreground(tokens.text_base);
        cx.focus_ring(2.0, 2.5, tokens.focus_ring);
        cx.web_focus();
        crate::views::shell::view(state, cx, &kit, &tokens)
    }

    #[test]
    fn full_bleed_split_sidebar_open_collapse_animation_and_collapsed_alignment() {
        let mut s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        s.onboarding.completed = true;
        s.shell_ui.viewport_width = 1280.0;
        s.desktop_settings.reduce_motion = false;

        let mut rt = Runtime::new(s, shell_test_root, (1280.0, 820.0), Env::new(true, 1.0));
        let mut mac_insets = rune::ChromeInsets::default();
        mac_insets.leading = 76.0;
        mac_insets.height = 48.0;
        rt.set_titlebar_inset(76.0);
        rt.set_chrome_insets(mac_insets);
        rt.frame(0.0);

        let (sidebar_rect, _) = rt.presented("sidebar-pane").expect("sidebar open");
        let (main_rect, _) = rt.presented("main-column").expect("main column mounted");
        let (toggle_rect, _) = rt
            .presented("sidebar-toggle")
            .expect("sidebar toggle mounted");
        let (back_rect, _) = rt.presented("topbar-back").expect("back btn mounted");

        assert_eq!(sidebar_rect[0], 0.0);
        assert_eq!(sidebar_rect[1], 0.0);
        assert!((main_rect[0] - sidebar_rect[2]).abs() < 0.5);
        assert_eq!(main_rect[1], 0.0);
        assert!((main_rect[0] + main_rect[2] - 1280.0).abs() < 0.5);
        assert!((main_rect[3] - 820.0).abs() < 0.5);
        let band = crate::theme::layout::SHELL_TOOLBAR_HEIGHT;
        let toggle_y = (band - super::TOGGLE_SIDE) / 2.0;
        assert!((toggle_rect[1] - toggle_y).abs() < 0.5);
        let toggle_center_y = toggle_rect[1] + toggle_rect[3] * 0.5;
        let back_center_y = back_rect[1] + back_rect[3] * 0.5;
        assert!(
            (toggle_center_y - band / 2.0).abs() < 0.5 && (back_center_y - band / 2.0).abs() < 0.5,
            "sidebar toggle ({toggle_center_y}) and nav ({back_center_y}) must both center in the toolbar band"
        );
        // Back and forward sit in the sidebar's title bar, right after the toggle.
        assert!(
            back_rect[0] >= toggle_rect[0] + toggle_rect[2]
                && back_rect[0] + back_rect[2] <= sidebar_rect[2],
            "back must sit beside the toggle inside the open sidebar: toggle={toggle_rect:?}, back={back_rect:?}"
        );
        let open_toggle_x = toggle_rect[0];
        let open_back_x = back_rect[0];

        // Collapse: the toggle/nav cluster stays put while the sidebar slides away.
        rt.state.sidebar.set_open(false);
        rt.frame(0.0);
        for _ in 0..15 {
            rt.frame(1.0 / 60.0);
            let (mid_toggle, _) = rt.presented("sidebar-toggle").unwrap();
            let (mid_back, _) = rt.presented("topbar-back").unwrap();
            assert!(
                (mid_toggle[1] - toggle_y).abs() < 0.5
                    && (mid_toggle[0] - open_toggle_x).abs() < 0.5
                    && (mid_back[0] - open_back_x).abs() < 0.5,
                "toggle and nav must not move mid-collapse: toggle={mid_toggle:?}, back={mid_back:?}"
            );
        }
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }

        let (collapsed_main, _) = rt.presented("main-column").unwrap();
        let (collapsed_toggle, _) = rt.presented("sidebar-toggle").unwrap();
        let (collapsed_fwd, _) = rt.presented("topbar-forward").unwrap();
        let (collapsed_title, _) = rt.presented("topbar-title").unwrap();
        assert!(
            collapsed_main[0].abs() < 0.5
                && collapsed_main[1].abs() < 0.5
                && (collapsed_main[2] - 1280.0).abs() < 0.5
                && (collapsed_main[3] - 820.0).abs() < 0.5,
            "collapsed main column must go full-bleed edge-to-edge: {collapsed_main:?}"
        );
        assert!(
            collapsed_toggle[0] >= 88.0 && (collapsed_toggle[1] - toggle_y).abs() < 0.5,
            "collapsed toggle must sit past 76pt leading chrome, centered vertically: {collapsed_toggle:?}"
        );
        assert!(
            collapsed_title[0] >= collapsed_fwd[0] + collapsed_fwd[2] + 6.0,
            "toolbar title must clear the toggle/nav cluster when collapsed: fwd={collapsed_fwd:?}, title={collapsed_title:?}"
        );
    }

    #[test]
    fn vibrant_sidebar_stays_visible_and_aligned_throughout_collapse_and_expand() {
        use rune::{El, Spring, col, el};

        fn vibrant_root(state: &AppState, cx: &mut Cx<AppState>) -> El {
            let (kit, _) = theme::build_kit_with_accent(
                true,
                false,
                false,
                state.desktop_settings.accent_palette,
            );
            cx.web_focus();
            super::FullBleedSplit::new(el().key("main-body").w_full().h_full())
                .sidebar(
                    &state.sidebar,
                    false,
                    |s: &mut AppState| &mut s.sidebar,
                    |s: &mut AppState| &mut s.shell_ui.sidebar_resize_start_width,
                    col().key("sb-items").w_full().h_full().child(
                        rune_kit::Button::new("New chat")
                            .on_press(|_: &mut AppState| {})
                            .build(&kit)
                            .key("sb-item-btn"),
                    ),
                )
                .sidebar_vibrancy(Some(crate::theme::layout::SIDEBAR_TINT_ALPHA_DARK))
                .spring(Spring::new(0.3, 0.0))
                .build(&kit)
        }

        let mut s = AppState::default();
        s.sidebar.set_width(240.0);
        s.sidebar.set_open(true);

        let mut rt = Runtime::new(s, vibrant_root, (1280.0, 820.0), Env::new(true, 1.0));
        rt.frame(0.0);

        let assert_frame_coherent = |rt: &Runtime<AppState>, phase: &str| {
            let (slot, slot_op) = rt.presented("sidebar-pane").expect("sidebar-pane");
            let (tint, tint_op) = rt
                .presented("sidebar-vibrancy-tint")
                .expect("sidebar-vibrancy-tint");
            let (content, content_op) = rt.presented("pane-content").expect("pane-content");
            let (main, _) = rt.presented("main-column").expect("main-column");

            assert!(
                slot[0].abs() < 0.5 && (slot_op - 1.0).abs() < 1e-3,
                "{phase}: slot must stay at x=0 and full opacity: rect={slot:?}, op={slot_op}"
            );
            assert!(
                (main[0] - slot[2]).abs() < 0.5,
                "{phase}: main column must track slot width: slot={slot:?}, main={main:?}"
            );
            assert!(
                tint[0].abs() < 0.5
                    && (tint[2] - slot[2]).abs() < 0.5
                    && (tint_op - 1.0).abs() < 1e-3,
                "{phase}: vibrancy tint must cover slot at full opacity: slot={slot:?}, tint={tint:?}, op={tint_op}"
            );
            assert!(
                (content_op - 1.0).abs() < 1e-3
                    && ((content[0] + content[2]) - slot[2]).abs() < 0.5,
                "{phase}: sliding content must stay at full opacity pinned to slot edge: slot={slot:?}, content={content:?}, op={content_op}"
            );
        };

        assert_frame_coherent(&rt, "open-rest");

        // Collapse and inspect mid-animation frames.
        rt.update(|s, _| s.sidebar.set_open(false));
        let mut saw_mid_collapse = false;
        for _ in 0..30 {
            rt.frame(1.0 / 60.0);
            let (slot, _) = rt.presented("sidebar-pane").unwrap();
            if slot[2] > 20.0 && slot[2] < 220.0 {
                saw_mid_collapse = true;
                assert_frame_coherent(&rt, "mid-collapse");
            }
        }
        assert!(saw_mid_collapse, "expected mid-collapse frames");
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }
        let (collapsed_slot, _) = rt.presented("sidebar-pane").unwrap();
        assert!(
            collapsed_slot[2] < 0.5,
            "sidebar slot should reach 0 width when collapsed: {collapsed_slot:?}"
        );

        // Expand and inspect mid-animation frames.
        rt.update(|s, _| s.sidebar.set_open(true));
        let mut saw_mid_expand = false;
        for _ in 0..30 {
            rt.frame(1.0 / 60.0);
            let (slot, _) = rt.presented("sidebar-pane").unwrap();
            if slot[2] > 20.0 && slot[2] < 220.0 {
                saw_mid_expand = true;
                assert_frame_coherent(&rt, "mid-expand");
            }
        }
        assert!(saw_mid_expand, "expected mid-expand frames");
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }
        assert_frame_coherent(&rt, "reopened-rest");
    }

    #[test]
    fn full_bleed_split_preserves_linux_and_windows_leading_trailing_chrome() {
        let mut linux_s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        linux_s.onboarding.completed = true;
        linux_s.shell_ui.viewport_width = 1280.0;
        linux_s.sidebar.set_open(false);
        let mut linux_rt = Runtime::new(
            linux_s,
            shell_test_root,
            (1280.0, 820.0),
            Env::new(true, 1.0),
        );
        linux_rt.set_titlebar_inset(0.0);
        linux_rt.set_chrome_insets(rune::ChromeInsets::default());
        linux_rt.frame(0.0);

        let (linux_toggle, _) = linux_rt.presented("sidebar-toggle").unwrap();
        assert!(
            (linux_toggle[0] - 12.0).abs() < 0.5,
            "Linux collapsed toggle starts 12pt from edge: {linux_toggle:?}"
        );

        let mut win_s = AppState {
            scene_mode: true,
            ..Default::default()
        };
        win_s.onboarding.completed = true;
        win_s.shell_ui.viewport_width = 1280.0;
        let mut win_rt = Runtime::new(win_s, shell_test_root, (1280.0, 820.0), Env::new(true, 1.0));
        let mut win_insets = rune::ChromeInsets::default();
        win_insets.trailing = 138.0;
        win_insets.height = 48.0;
        win_rt.set_titlebar_inset(0.0);
        win_rt.set_chrome_insets(win_insets);
        win_rt.frame(0.0);

        let (reserve_rect, _) = win_rt
            .presented("topbar-caption-reserve")
            .expect("Windows caption reserve must mount");
        assert!(
            reserve_rect[0] >= 1120.0 && reserve_rect[0] + reserve_rect[2] <= 1280.0,
            "Windows caption reserve must stay on trailing edge: {reserve_rect:?}"
        );
    }
}
