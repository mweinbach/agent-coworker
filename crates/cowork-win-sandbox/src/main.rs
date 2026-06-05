//! `cowork-win-sandbox` — minimal Windows sandbox helper for agent-coworker.
//!
//! This is the Windows analog of `/usr/bin/sandbox-exec` (macOS) and `bwrap`
//! (Linux): the TypeScript `SandboxManager` (`src/platform/sandbox/windows.ts`)
//! prepends this helper to the command, e.g.
//!
//! ```text
//! cowork-win-sandbox.exe --mode workspace-write --writable-root C:\work \
//!   --cwd C:\work -- powershell.exe -NoProfile -Command "<cmd>"
//! ```
//!
//! The helper drops privileges with a restricted token and contains the child
//! in a kill-on-close Job Object before executing it. It is modeled on the
//! restricted-token path of OpenAI Codex's `windows-sandbox-rs`
//! (`windows-sandbox-rs/src/token.rs`, `src/bin/command_runner`). The Windows
//! Filtering Platform (network) layer and per-root ACL filesystem scoping that
//! Codex also implements are intentionally **out of scope for v1** (see the
//! `// TODO(win-sandbox)` notes and README); workspace-write currently relies on
//! privilege reduction + Job Object containment rather than fine-grained ACLs.
//!
//! NOTE: The Win32 implementation below must be built and verified on a Windows
//! runner (no Windows target exists in the Linux dev/CI sandbox). The non-Windows
//! build is a stub that refuses to run.

use std::process::ExitCode;

/// Parsed CLI options. The command to run follows a literal `--` separator.
#[derive(Debug)]
pub struct Options {
    /// "read-only" | "workspace-write" (danger-full-access never invokes the helper).
    pub mode: String,
    /// Absolute roots that should remain writable under workspace-write.
    pub writable_roots: Vec<String>,
    /// Working directory for the child process.
    pub cwd: Option<String>,
    /// Whether outbound network is permitted (informational in v1; no WFP yet).
    pub allow_network: bool,
    /// The program and its arguments (everything after `--`).
    pub command: Vec<String>,
}

fn parse_args() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let mut opts = Options {
        mode: "workspace-write".to_string(),
        writable_roots: Vec::new(),
        cwd: None,
        allow_network: false,
        command: Vec::new(),
    };

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => opts.mode = args.next().ok_or("missing value for --mode")?,
            "--writable-root" => opts
                .writable_roots
                .push(args.next().ok_or("missing value for --writable-root")?),
            "--cwd" => opts.cwd = Some(args.next().ok_or("missing value for --cwd")?),
            "--allow-network" => opts.allow_network = true,
            "--" => {
                opts.command = args.by_ref().collect();
                break;
            }
            other => return Err(format!("unexpected argument: {other}")),
        }
    }

    if opts.command.is_empty() {
        return Err("missing command after `--`".to_string());
    }
    Ok(opts)
}

fn main() -> ExitCode {
    let opts = match parse_args() {
        Ok(opts) => opts,
        Err(err) => {
            eprintln!("cowork-win-sandbox: {err}");
            return ExitCode::from(2);
        }
    };

    #[cfg(windows)]
    {
        // Use process::exit (not ExitCode) so the child's full 32-bit Windows
        // exit code is propagated instead of being truncated to a u8.
        match win::run(&opts) {
            Ok(code) => std::process::exit(code as i32),
            Err(err) => {
                eprintln!("cowork-win-sandbox: {err}");
                std::process::exit(2);
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = &opts;
        eprintln!("cowork-win-sandbox is only supported on Windows");
        ExitCode::from(2)
    }
}

#[cfg(windows)]
mod win {
    //! Win32 restricted-token + Job Object implementation.
    //!
    //! Cribbed from OpenAI Codex `windows-sandbox-rs`. Build + verify on Windows.
    use super::Options;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Security::{CreateRestrictedToken, LUA_TOKEN};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
        ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows::Win32::Security::{TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY};

    /// Build a UTF-16, NUL-terminated wide string for Win32 `*W` APIs.
    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Quote a single argv element following the Windows command-line rules so
    /// that the child's CRT re-parses it back into the original token.
    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            return arg.to_string();
        }
        let mut quoted = String::from("\"");
        let mut backslashes = 0usize;
        for ch in arg.chars() {
            match ch {
                '\\' => {
                    backslashes += 1;
                }
                '"' => {
                    quoted.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                    quoted.push('"');
                    backslashes = 0;
                }
                _ => {
                    quoted.extend(std::iter::repeat('\\').take(backslashes));
                    quoted.push(ch);
                    backslashes = 0;
                }
            }
        }
        quoted.extend(std::iter::repeat('\\').take(backslashes * 2));
        quoted.push('"');
        quoted
    }

    fn build_command_line(command: &[String]) -> String {
        command
            .iter()
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn run(opts: &Options) -> Result<u32, String> {
        // TODO(win-sandbox): apply per-root deny/allow ACLs (workspace-write) and
        // WFP network filtering (network restriction). v1 reduces privilege via a
        // restricted token and contains the process tree in a Job Object.
        let _ = (&opts.mode, &opts.writable_roots, opts.allow_network);

        unsafe {
            // 1. Derive a restricted (LUA) token from the current process token.
            let mut process_token = HANDLE::default();
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY,
                &mut process_token,
            )
            .map_err(|e| format!("OpenProcessToken failed: {e}"))?;

            let mut restricted_token = HANDLE::default();
            CreateRestrictedToken(
                process_token,
                LUA_TOKEN,
                None, // SidsToDisable
                None, // PrivilegesToDelete
                None, // SidsToRestrict
                &mut restricted_token,
            )
            .map_err(|e| format!("CreateRestrictedToken failed: {e}"))?;
            let _ = CloseHandle(process_token);

            // 2. Create a Job Object that kills the child tree when we exit.
            let job = CreateJobObjectW(None, PWSTR::null())
                .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                core::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| format!("SetInformationJobObject failed: {e}"))?;

            // 3. Spawn the command under the restricted token, suspended, so we can
            //    assign it to the Job Object before it runs.
            let mut command_line = wide(&build_command_line(&opts.command));
            let cwd_wide = opts.cwd.as_ref().map(|c| wide(c));
            let startup = STARTUPINFOW {
                cb: core::mem::size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut info = PROCESS_INFORMATION::default();

            CreateProcessAsUserW(
                restricted_token,
                None,
                PWSTR(command_line.as_mut_ptr()),
                None,
                None,
                true, // inherit std handles for stdio passthrough
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                None,
                cwd_wide
                    .as_ref()
                    .map(|c| windows::core::PCWSTR(c.as_ptr())),
                &startup,
                &mut info,
            )
            .map_err(|e| format!("CreateProcessAsUserW failed: {e}"))?;

            AssignProcessToJobObject(job, info.hProcess)
                .map_err(|e| format!("AssignProcessToJobObject failed: {e}"))?;
            ResumeThread(info.hThread);

            // 4. Wait for completion and propagate the exit code.
            if WaitForSingleObject(info.hProcess, INFINITE) != WAIT_OBJECT_0 {
                return Err("WaitForSingleObject failed".to_string());
            }
            let mut exit_code: u32 = 0;
            GetExitCodeProcess(info.hProcess, &mut exit_code)
                .map_err(|e| format!("GetExitCodeProcess failed: {e}"))?;

            let _ = CloseHandle(info.hThread);
            let _ = CloseHandle(info.hProcess);
            let _ = CloseHandle(restricted_token);
            let _ = CloseHandle(job);

            Ok(exit_code)
        }
    }
}
