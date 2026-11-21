//! Platform-specific child process group spawning and tree termination.
//!
//! Replaces `apps/desktop/electron/services/serverPlatform.ts` and Electron's
//! `src/platform/processTree.ts` helper for `ServerManager`.

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Configures `cmd` so child stdio and OS process-group/console isolation match Electron.
pub fn configure_sidecar_command(cmd: &mut Command) {
    #[cfg(unix)]
    {
        // Put child in its own process group so `killpg` stops all descendants on timeout.
        cmd.process_group(0);
    }

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Returns whether POSIX `SIGTERM` is used on fallback termination (`false` on Windows).
pub fn uses_posix_termination_signal() -> bool {
    cfg!(unix)
}

/// Force-terminates the entire process tree rooted at `pid`.
pub async fn terminate_process_tree(pid: u32) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        // Signal the child's process group (`-pid`) first; fall back to `pid` if not group leader.
        let pgid = -(pid as libc::pid_t);
        let rc = unsafe { libc::kill(pgid, libc::SIGKILL) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            let raw = err.raw_os_error();
            if raw == Some(libc::ESRCH) {
                return Ok(());
            }
            let fallback_rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            if fallback_rc != 0 {
                let fallback_err = std::io::Error::last_os_error();
                if fallback_err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(fallback_err);
                }
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    {
        let status = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await?;
        if status.success() { Ok(()) } else { Ok(()) }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_sidecar_command_builds_without_panicking() {
        let mut cmd = Command::new("cowork-server");
        configure_sidecar_command(&mut cmd);
        let _ = uses_posix_termination_signal();
    }
}
