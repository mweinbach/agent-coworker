//! Native file/folder/save dialog options and platform-consistent confirmation prompt
//! builders matching `apps/desktop/electron/services/dialogs.ts` and `ipc/files.ts`.

use std::path::Path;

use cowork_config::host_platform;
use rune::FileDialogOptions;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmDialogKind {
    Info,
    Warning,
    Question,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmDialogSpec {
    pub kind: ConfirmDialogKind,
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub confirm_label: String,
    pub cancel_label: String,
    pub buttons: Vec<String>,
    pub default_button_index: usize,
    pub cancel_button_index: usize,
    pub confirm_button_index: usize,
}

pub fn build_open_folder_dialog(title: Option<&str>) -> FileDialogOptions {
    FileDialogOptions {
        title: title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Select a Workspace Folder")
            .to_string(),
        ..Default::default()
    }
}

pub fn build_open_files_dialog(title: Option<&str>, allow_multiple: bool) -> FileDialogOptions {
    // Single vs. multi-select is chosen by `Tx::open_file` vs. `Tx::open_files`.
    let _ = allow_multiple;
    FileDialogOptions {
        title: title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Select Files")
            .to_string(),
        ..Default::default()
    }
}

pub fn build_save_canvas_dialog(source_path: &Path) -> FileDialogOptions {
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let suggested = format!("{stem} copy{ext}");

    FileDialogOptions {
        title: "Save Canvas document as".to_string(),
        directory: source_path.parent().map(Path::to_path_buf),
        file_name: Some(suggested),
        ..Default::default()
    }
}

pub fn build_confirm_dialog(
    kind: ConfirmDialogKind,
    title: impl Into<String>,
    message: impl Into<String>,
    detail: Option<String>,
    confirm_label: Option<&str>,
    cancel_label: Option<&str>,
    default_confirm: bool,
) -> ConfirmDialogSpec {
    build_confirm_dialog_for_platform(
        kind,
        title,
        message,
        detail,
        confirm_label,
        cancel_label,
        default_confirm,
        host_platform(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_confirm_dialog_for_platform(
    kind: ConfirmDialogKind,
    title: impl Into<String>,
    message: impl Into<String>,
    detail: Option<String>,
    confirm_label: Option<&str>,
    cancel_label: Option<&str>,
    default_confirm: bool,
    platform: &str,
) -> ConfirmDialogSpec {
    let confirm = confirm_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Confirm")
        .to_string();
    let cancel = cancel_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Cancel")
        .to_string();

    if platform == "darwin" {
        let default_button_index = usize::from(default_confirm);
        ConfirmDialogSpec {
            kind,
            title: title.into(),
            message: message.into(),
            detail,
            buttons: vec![cancel.clone(), confirm.clone()],
            confirm_label: confirm,
            cancel_label: cancel,
            default_button_index,
            cancel_button_index: 0,
            confirm_button_index: 1,
        }
    } else {
        let default_button_index = usize::from(!default_confirm);
        ConfirmDialogSpec {
            kind,
            title: title.into(),
            message: message.into(),
            detail,
            buttons: vec![confirm.clone(), cancel.clone()],
            confirm_label: confirm,
            cancel_label: cancel,
            default_button_index,
            cancel_button_index: 1,
            confirm_button_index: 0,
        }
    }
}

pub fn build_launchable_file_confirm(file_path: &Path) -> ConfirmDialogSpec {
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    build_confirm_dialog(
        ConfirmDialogKind::Warning,
        "Open file that can run code?",
        format!("“{name}” can run programs on this computer."),
        Some(
            "Opening it runs it outside Cowork’s sandbox. Only continue if you trust where this file came from."
                .to_string(),
        ),
        Some("Open Anyway"),
        Some("Cancel"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_order_matches_platform_conventions() {
        let mac = build_confirm_dialog_for_platform(
            ConfirmDialogKind::Warning,
            "Title",
            "Message",
            None,
            Some("Delete"),
            Some("Keep"),
            false,
            "darwin",
        );
        assert_eq!(mac.buttons, vec!["Keep", "Delete"]);
        assert_eq!(mac.cancel_button_index, 0);
        assert_eq!(mac.confirm_button_index, 1);
        assert_eq!(mac.default_button_index, 0);

        let win = build_confirm_dialog_for_platform(
            ConfirmDialogKind::Warning,
            "Title",
            "Message",
            None,
            Some("Delete"),
            Some("Keep"),
            false,
            "win32",
        );
        assert_eq!(win.buttons, vec!["Delete", "Keep"]);
        assert_eq!(win.confirm_button_index, 0);
        assert_eq!(win.cancel_button_index, 1);
        assert_eq!(win.default_button_index, 1);
    }
}
