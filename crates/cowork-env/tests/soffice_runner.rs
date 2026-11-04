// The sandboxed runner tests drive `#!/bin/bash` soffice/pdftoppm fixtures and POSIX process
// groups, so they are Unix-only; argument validation is portable and runs everywhere.
#[cfg(unix)]
use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use cowork_config::canonicalize_sync;
use cowork_env::validate_soffice_args;
#[cfg(unix)]
use cowork_env::{
    LibreOfficeCheckStatus, PdftoppmJobRequest, SofficeConvertRequest, SofficeRunner,
    SofficeRunnerConfig,
};
#[cfg(unix)]
use cowork_sandbox::SandboxManager;
#[cfg(unix)]
use parking_lot::Mutex;
#[cfg(unix)]
use tempfile::TempDir;

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

#[cfg(unix)]
fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("create tempdir in system temp dir");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

/// `file://` URL prefix of the canonical platform scratch root under which `SofficeRunner`
/// creates per-job `-env:UserInstallation` profiles (`/private/tmp` on macOS, `/tmp` on Linux).
#[cfg(unix)]
fn scratch_profile_url_prefix() -> String {
    let scratch = cowork_sandbox::scratch_roots(None)
        .into_iter()
        .next()
        .expect("platform scratch root");
    format!("file://{}/", canonicalize_sync(&scratch).display())
}

/// A `sleep` duration argument unique to this test process (e.g. `60.123456`), so a sleeper can be
/// identified by its argv in the host process table.
#[cfg(unix)]
fn unique_sleep_arg(whole_secs: u32) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    format!(
        "{whole_secs}.{:05}{:04}",
        std::process::id() % 100_000,
        nanos % 10_000
    )
}

/// Whether the `sleep <sleep_arg>` grandchild still runs. On Linux the sandboxed command lives in
/// a private PID namespace, so match on argv in `/proc` (ignoring zombies, which have already
/// been killed and only await reaping); elsewhere the echoed PID is a host PID.
#[cfg(target_os = "linux")]
fn grandchild_alive(_sandbox_pid: i32, sleep_arg: &str) -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let proc_dir = entry.path();
        let Ok(cmdline) = std::fs::read(proc_dir.join("cmdline")) else {
            return false;
        };
        let argv: Vec<&[u8]> = cmdline
            .split(|b| *b == 0)
            .filter(|a| !a.is_empty())
            .collect();
        let is_sleeper = argv.len() == 2
            && argv[0].rsplit(|b| *b == b'/').next() == Some(b"sleep".as_slice())
            && argv[1] == sleep_arg.as_bytes();
        if !is_sleeper {
            return false;
        }
        let state = std::fs::read_to_string(proc_dir.join("stat"))
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(')')
                    .map(|(_, rest)| rest.trim_start().to_owned())
            })
            .and_then(|rest| rest.chars().next());
        !matches!(state, Some('Z' | 'X') | None)
    })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn grandchild_alive(sandbox_pid: i32, _sleep_arg: &str) -> bool {
    unsafe { libc::kill(sandbox_pid, 0) == 0 }
}

#[cfg(unix)]
fn write_executable(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[test]
fn validate_soffice_args_strictly_rejects_ui_macro_print_remote_and_profile_override_flags() {
    // Allowed headless conversion / version flags:
    assert!(validate_soffice_args(&["--version".to_owned()]).is_ok());
    assert!(
        validate_soffice_args(&[
            "--convert-to".to_owned(),
            "pdf".to_owned(),
            "--outdir".to_owned(),
            "/private/tmp/out".to_owned(),
            "/private/tmp/in/doc.docx".to_owned(),
        ])
        .is_ok()
    );

    // Strictly forbidden interactive UI, macro, print, socket, URL, and profile flags:
    let forbidden_cases: &[&[&str]] = &[
        &["--writer"],
        &["--calc"],
        &["--impress"],
        &["--draw"],
        &["--math"],
        &["--base"],
        &["--show", "deck.pptx"],
        &["--view", "doc.odt"],
        &["-o", "doc.odt"],
        &["-n", "doc.odt"],
        &["--quickstart"],
        &["--display", ":0"],
        &["-p", "doc.odt"],
        &["--pt", "LaserJet", "doc.odt"],
        &["--print-to-file", "doc.odt"],
        &["--printer-name", "LaserJet"],
        &["--accept=socket,host=127.0.0.1,port=2002;urp;"],
        &["--unaccept=all"],
        &["macro:///Standard.Module1.Main()"],
        &["vnd.sun.star.script:myScript.py$run?language=Python&location=user"],
        &[".uno:Save"],
        &["slot:5500"],
        &["https://evil.example.com/payload.docx"],
        &["-env:UserInstallation=file:///private/tmp/attacker-profile"],
        &["--unknown-experimental-flag"],
    ];

    for args in forbidden_cases {
        let owned: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
        let res = validate_soffice_args(&owned);
        assert!(
            res.is_err(),
            "expected forbidden soffice args {args:?} to be rejected before spawn"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn soffice_runner_enforces_bounded_concurrency_isolated_profiles_os_sandbox_and_pdftoppm() {
    let (_tmp, root) = canonical_temp_dir("cowork-soffice-pool-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    let runtime_bin = root.join("runtime/bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&runtime_bin).unwrap();

    // Create a local managed `soffice` fixture that:
    // 1. Verifies `--headless` and `-env:UserInstallation=file://<scratch root>/...` were injected,
    // 2. Writes a `.lock` file inside its isolated `UserInstallation` profile dir (fails if another concurrent process already holds it!),
    // 3. Verifies workspace write & network are blocked by the OS sandbox (`Seatbelt`),
    // 4. Sleeps 120ms so we can measure bounded concurrency (`max_concurrent = 2`),
    // 5. Writes a valid `%PDF-1.4` output file containing the profile path for uniqueness verification.
    let soffice_bin = runtime_bin.join("soffice");
    let soffice_script = r#"#!/bin/bash
set -euo pipefail

for arg in "$@"; do
  if [[ "$arg" == "--version" ]]; then
    echo "LibreOffice 26.2.3.2 420(Build:2)"
    exit 0
  fi
done

has_headless=0
profile_url=""
outdir=""
input_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless) has_headless=1; shift ;;
    -env:UserInstallation=*) profile_url="${1#-env:UserInstallation=}"; shift ;;
    --convert-to) shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    --*) shift ;;
    *) input_file="$1"; shift ;;
  esac
done

if [[ "$has_headless" -ne 1 ]]; then
  echo "missing --headless" >&2
  exit 11
fi
if [[ "$profile_url" != __SCRATCH_PROFILE_URL_PREFIX__* ]]; then
  echo "unexpected UserInstallation URL: $profile_url" >&2
  exit 12
fi

profile_dir="${profile_url#file://}"
mkdir -p "$profile_dir/user"
if [[ -f "$profile_dir/.lock" ]]; then
  echo "PROFILE COLLISION in $profile_dir" >&2
  exit 13
fi
echo "$$" > "$profile_dir/.lock"

# Verify OS sandbox blocks writes to workspace (`pwd` is `cwd = workspace`)!
if echo "escaped" > "$(pwd)/seatbelt-workspace-probe.txt" 2>/dev/null; then
  echo "SANDBOX FAILURE: wrote to workspace!" >&2
  exit 14
fi

# Verify OS sandbox kernel-blocks outbound TCP with EPERM/EACCES (`network = false`)!
if /usr/bin/python3 -c 'import errno, socket, sys
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.05)
    s.connect(("8.8.8.8", 53))
    sys.exit(0)
except OSError as e:
    sys.exit(1 if e.errno in (errno.EPERM, errno.EACCES) else 0)
' 2>/dev/null; then
  echo "SANDBOX FAILURE: outbound socket was not blocked with EPERM!" >&2
  exit 15
fi

sleep 0.12

base="$(basename "$input_file")"
stem="${base%.*}"
printf '%%PDF-1.4\n%% profile=%s\n1 0 obj << /Type /Catalog >> endobj\n%%%%EOF\n' "$profile_dir" > "${outdir}/${stem}.pdf"
"#;
    let soffice_script = soffice_script.replace(
        "__SCRATCH_PROFILE_URL_PREFIX__",
        &scratch_profile_url_prefix(),
    );
    write_executable(&soffice_bin, &soffice_script);

    let pdftoppm_bin = runtime_bin.join("pdftoppm");
    let pdftoppm_script = r#"#!/bin/bash
set -euo pipefail
prefix="${@: -1}"
printf '\x89PNG\r\n\x1a\n' > "${prefix}-1.png"
"#;
    write_executable(&pdftoppm_bin, pdftoppm_script);

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        soffice_bin.to_string_lossy().into_owned(),
    );
    env.insert(
        "COWORK_RUNTIME_PDFTOPPM".to_owned(),
        pdftoppm_bin.to_string_lossy().into_owned(),
    );

    let runner = Arc::new(SofficeRunner::new(SofficeRunnerConfig {
        max_concurrent: 2,
        default_timeout: Duration::from_secs(10),
        sandbox_manager: SandboxManager::new(),
        homedir: home.clone(),
    }));

    // Launch 5 conversions simultaneously and assert:
    // - peak observed active jobs <= 2,
    // - 5 distinct `-env:UserInstallation` profile directories were used,
    // - all 5 temporary profile directories were cleaned up after completion!
    let seen_profiles: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let peak_active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();

    for idx in 0..5 {
        let input_path = root.join(format!("slide-{idx}.html"));
        std::fs::write(
            &input_path,
            format!("<html><body>Slide {idx}</body></html>"),
        )
        .unwrap();
        let out_dir = root.join(format!("out-{idx}"));
        std::fs::create_dir_all(&out_dir).unwrap();

        let r = runner.clone();
        let env_clone = env.clone();
        let ws_clone = workspace.clone();
        let seen = seen_profiles.clone();
        let peak = peak_active.clone();

        handles.push(tokio::spawn(async move {
            let res = r
                .convert_document(SofficeConvertRequest {
                    input_path,
                    output_dir: out_dir.clone(),
                    convert_to: "pdf".to_owned(),
                    extra_args: Vec::new(),
                    cwd: ws_clone,
                    env: env_clone,
                    timeout: Some(Duration::from_secs(10)),
                })
                .await
                .expect("sandboxed soffice conversion");
            peak.fetch_max(
                res.observed_pool_in_flight,
                std::sync::atomic::Ordering::SeqCst,
            );
            let pdf_text = std::fs::read_to_string(&res.output_path).unwrap();
            let profile_line = pdf_text
                .lines()
                .find_map(|l| l.strip_prefix("% profile="))
                .expect("profile marker in generated pdf")
                .to_owned();
            seen.lock().insert(profile_line);
            res.output_path
        }));
    }

    for h in handles {
        let out_pdf = h.await.unwrap();
        assert!(out_pdf.is_file());
    }

    let observed_peak = peak_active.load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        (1..=2).contains(&observed_peak),
        "bounded pool max_concurrent=2 violated: peak={observed_peak}"
    );

    let profiles = seen_profiles.lock().clone();
    assert_eq!(
        profiles.len(),
        5,
        "each invocation must receive a unique -env:UserInstallation directory"
    );
    for p in &profiles {
        assert!(
            !Path::new(p).exists(),
            "temporary LibreOffice profile {p} was not cleaned up!"
        );
    }

    // Exercise `pdftoppm` through the same bounded sandboxed runner.
    let sample_pdf = root.join("out-0/slide-0.pdf");
    let png_out_dir = root.join("png-out");
    std::fs::create_dir_all(&png_out_dir).unwrap();
    let pages = runner
        .render_pdf_pages(PdftoppmJobRequest {
            pdf_path: sample_pdf,
            output_dir: png_out_dir,
            dpi: 150,
            first_page: Some(1),
            last_page: Some(1),
            cwd: workspace.clone(),
            env: env.clone(),
            timeout: Some(Duration::from_secs(10)),
        })
        .await
        .expect("render pdf pages via pdftoppm");
    assert_eq!(pages.len(), 1);
    assert!(pages[0].is_file());

    // Exercise `check_libreoffice_capability`:
    // 1. Missing `COWORK_RUNTIME_SOFFICE` -> `unavailable` (never falls back to host PATH).
    let mut env_missing = env.clone();
    env_missing.remove("COWORK_RUNTIME_SOFFICE");
    let diag_missing = runner
        .check_capability(&workspace, &env_missing, false)
        .await;
    assert_eq!(diag_missing.status, LibreOfficeCheckStatus::Unavailable);
    assert!(diag_missing.message.contains("active Cowork runtime"));

    // 2. `smoke: false` -> `available` with version `26.2.3.2` and `smoke: None`.
    let diag_ver = runner.check_capability(&workspace, &env, false).await;
    assert_eq!(diag_ver.status, LibreOfficeCheckStatus::Available);
    assert_eq!(diag_ver.version.as_deref(), Some("26.2.3.2"));
    assert!(diag_ver.smoke.is_none());

    // 3. `smoke: true` -> `available` with `smoke.ok == true` and `size_bytes > 0`.
    let diag_smoke = runner.check_capability(&workspace, &env, true).await;
    assert_eq!(diag_smoke.status, LibreOfficeCheckStatus::Available);
    let smoke = diag_smoke.smoke.expect("smoke payload");
    assert!(smoke.ok, "smoke error: {:?}", smoke.error);
    assert!(smoke.size_bytes.unwrap_or(0) > 10);
}

#[cfg(unix)]
#[tokio::test]
async fn soffice_runner_timeout_kills_soffice_bin_process_group_and_cleans_temp_profile() {
    let (_tmp, root) = canonical_temp_dir("cowork-soffice-timeout-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    let runtime_bin = root.join("runtime/bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&runtime_bin).unwrap();

    let soffice_bin = runtime_bin.join("soffice");
    // Spawn a grandchild background sleeper (`soffice.bin` equivalent) and write both the
    // profile path and grandchild PID into `$TMPDIR`? Wait: Seatbelt allows writing to the
    // job's isolated scratch/output dir! So write grandchild PID + profile path into `--outdir`!
    let hung_script = r#"#!/bin/bash
profile_url=""
outdir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -env:UserInstallation=*) profile_url="${1#-env:UserInstallation=}"; shift ;;
    --outdir) outdir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
profile_dir="${profile_url#file://}"
mkdir -p "$profile_dir/user"
echo "locked" > "$profile_dir/.lock"
sleep __SLEEP_ARG__ &
grandchild_pid=$!
echo "$grandchild_pid" > "${outdir}/grandchild.pid"
echo "$profile_dir" > "${outdir}/profile.path"
wait "$grandchild_pid"
"#;
    // Unique sleep duration so the grandchild can be found in the host process table: under Linux
    // bwrap (`--unshare-pid`) the `$!` written to `grandchild.pid` is a sandbox-namespace PID.
    let sleep_arg = unique_sleep_arg(60);
    let hung_script = hung_script.replace("__SLEEP_ARG__", &sleep_arg);
    write_executable(&soffice_bin, &hung_script);

    let out_dir = root.join("hung-out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let input = root.join("hung.html");
    std::fs::write(&input, "<html>hung</html>").unwrap();

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        soffice_bin.to_string_lossy().into_owned(),
    );

    let runner = SofficeRunner::new(SofficeRunnerConfig {
        max_concurrent: 1,
        default_timeout: Duration::from_millis(350),
        sandbox_manager: SandboxManager::new(),
        homedir: home,
    });

    let err = runner
        .convert_document(SofficeConvertRequest {
            input_path: input,
            output_dir: out_dir.clone(),
            convert_to: "pdf".to_owned(),
            extra_args: Vec::new(),
            cwd: workspace,
            env,
            timeout: Some(Duration::from_millis(350)),
        })
        .await
        .expect_err("hung soffice must time out");
    assert!(
        err.to_string().to_lowercase().contains("time"),
        "expected timeout error, got: {err}"
    );

    // Verify grandchild `soffice.bin` sleeper was killed with the process group AND profile dir was removed!
    if let Ok(pid_raw) = std::fs::read_to_string(out_dir.join("grandchild.pid"))
        && let Ok(pid) = pid_raw.trim().parse::<i32>()
    {
        // Brief poll for kernel process table cleanup after SIGKILL.
        let mut alive = true;
        for _ in 0..40 {
            alive = grandchild_alive(pid, &sleep_arg);
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            !alive,
            "orphaned grandchild process `sleep {sleep_arg}` (sandbox pid {pid}) survived soffice timeout!"
        );
    }

    if let Ok(profile_raw) = std::fs::read_to_string(out_dir.join("profile.path")) {
        let profile_path = PathBuf::from(profile_raw.trim());
        assert!(
            !profile_path.exists(),
            "temporary profile directory {} leaked after timeout!",
            profile_path.display()
        );
    }
}

#[test]
fn soffice_read_denied_roots_cover_the_standard_credential_set() {
    let home = std::path::Path::new("/home/alice");
    let cwd = std::path::Path::new("/work/project");
    let roots = cowork_env::soffice_read_denied_roots(home, cwd);
    for expected in [
        home.join(".cowork").join("auth"),
        home.join(".cowork").join("mobile-pairing"),
        cwd.join(".cowork").join("auth"),
        home.join(".ssh"),
        home.join(".aws"),
        home.join(".gnupg"),
        home.join(".kube"),
        home.join(".azure"),
    ] {
        assert!(roots.contains(&expected), "{expected:?} missing: {roots:?}");
    }
}

/// Live bwrap: a crafted document (simulated by a fixture `soffice` / `pdftoppm` that tries to
/// inline credential files into its output) must not be able to read `~/.ssh`,
/// `~/.cowork/auth` or `<cwd>/.cowork/auth` during conversion, rendering or the version probe.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn soffice_runner_hides_credential_dirs_from_convert_render_and_version_probe() {
    let (_tmp, root) = canonical_temp_dir("cowork-soffice-creds-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    let runtime_bin = root.join("runtime/bin");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::write(home.join(".ssh").join("id_rsa"), "SSH-SENTINEL").unwrap();
    std::fs::create_dir_all(home.join(".cowork").join("auth")).unwrap();
    std::fs::write(
        home.join(".cowork").join("auth").join("connections.json"),
        "HOME-AUTH-SENTINEL",
    )
    .unwrap();
    std::fs::create_dir_all(workspace.join(".cowork").join("auth")).unwrap();
    std::fs::write(
        workspace.join(".cowork").join("auth").join("mcp.json"),
        "WS-AUTH-SENTINEL",
    )
    .unwrap();

    let secrets = [
        home.join(".ssh").join("id_rsa"),
        home.join(".cowork").join("auth").join("connections.json"),
        workspace.join(".cowork").join("auth").join("mcp.json"),
    ]
    .iter()
    .map(|p| format!("'{}'", p.display()))
    .collect::<Vec<_>>()
    .join(" ");

    let soffice_bin = runtime_bin.join("soffice");
    let soffice_script = r#"#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == "--version" ]]; then
    for f in __SECRETS__; do
      if cat "$f" >/dev/null 2>&1; then echo "LEAKED $f" >&2; exit 42; fi
    done
    echo "LibreOffice 26.2.3.2 420(Build:2)"
    exit 0
  fi
done
outdir=""
input_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --convert-to) shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    -*) shift ;;
    *) input_file="$1"; shift ;;
  esac
done
base="$(basename "$input_file")"
{
  printf '%%PDF-1.4\n'
  for f in __SECRETS__; do cat "$f" 2>/dev/null; echo; done
  printf '%%%%EOF\n'
} > "${outdir}/${base%.*}.pdf"
"#
    .replace("__SECRETS__", &secrets);
    write_executable(&soffice_bin, &soffice_script);

    let pdftoppm_bin = runtime_bin.join("pdftoppm");
    let pdftoppm_script = r#"#!/bin/bash
prefix="${@: -1}"
{
  printf '\x89PNG\r\n\x1a\n'
  for f in __SECRETS__; do cat "$f" 2>/dev/null; echo; done
} > "${prefix}-1.png"
"#
    .replace("__SECRETS__", &secrets);
    write_executable(&pdftoppm_bin, &pdftoppm_script);

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        soffice_bin.to_string_lossy().into_owned(),
    );
    env.insert(
        "COWORK_RUNTIME_PDFTOPPM".to_owned(),
        pdftoppm_bin.to_string_lossy().into_owned(),
    );

    let runner = SofficeRunner::new(SofficeRunnerConfig {
        max_concurrent: 1,
        default_timeout: Duration::from_secs(10),
        sandbox_manager: SandboxManager::new(),
        homedir: home.clone(),
    });

    let input = root.join("crafted.html");
    std::fs::write(&input, "<html><body>crafted</body></html>").unwrap();
    let out_dir = root.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let converted = runner
        .convert_document(SofficeConvertRequest {
            input_path: input,
            output_dir: out_dir,
            convert_to: "pdf".to_owned(),
            extra_args: Vec::new(),
            cwd: workspace.clone(),
            env: env.clone(),
            timeout: Some(Duration::from_secs(10)),
        })
        .await
        .expect("sandboxed conversion");
    let pdf = std::fs::read_to_string(&converted.output_path).unwrap();
    assert!(pdf.starts_with("%PDF-1.4"), "{pdf}");
    assert!(
        !pdf.contains("SENTINEL"),
        "credential leaked into PDF: {pdf}"
    );

    let png_dir = root.join("png");
    std::fs::create_dir_all(&png_dir).unwrap();
    let pages = runner
        .render_pdf_pages(PdftoppmJobRequest {
            pdf_path: converted.output_path.clone(),
            output_dir: png_dir,
            dpi: 72,
            first_page: None,
            last_page: None,
            cwd: workspace.clone(),
            env: env.clone(),
            timeout: Some(Duration::from_secs(10)),
        })
        .await
        .expect("sandboxed render");
    assert_eq!(pages.len(), 1);
    let png = String::from_utf8_lossy(&std::fs::read(&pages[0]).unwrap()).into_owned();
    assert!(!png.contains("SENTINEL"), "credential leaked into PNG");

    let diag = runner.check_capability(&workspace, &env, false).await;
    assert_eq!(
        diag.status,
        LibreOfficeCheckStatus::Available,
        "version probe could read credentials: {}",
        diag.message
    );
}

/// `check_capability(smoke: false)` runs `soffice --version` with `require_backend = false`; on a
/// host without an OS sandbox backend it must fall back to running unsandboxed (TS parity)
/// instead of being declined, while conversions still refuse to run unsandboxed.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn soffice_version_probe_falls_back_unsandboxed_without_a_backend() {
    let (_tmp, root) = canonical_temp_dir("cowork-soffice-nobackend-");
    let home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let soffice_bin = root.join("runtime/bin/soffice");
    write_executable(
        &soffice_bin,
        "#!/bin/bash\necho 'LibreOffice 26.2.3.2 420(Build:2)'\n",
    );

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        soffice_bin.to_string_lossy().into_owned(),
    );
    // An existing override that fails the namespace probe disables the only Linux backend (a
    // missing override now falls back to a trusted system bwrap).
    let failing_bwrap = root.join("failing-bwrap");
    write_executable(&failing_bwrap, "#!/bin/sh\nexit 1\n");
    env.insert(
        "COWORK_BWRAP_PATH".to_owned(),
        failing_bwrap.to_string_lossy().into_owned(),
    );

    let runner = SofficeRunner::new(SofficeRunnerConfig {
        max_concurrent: 1,
        default_timeout: Duration::from_secs(10),
        sandbox_manager: SandboxManager::new(),
        homedir: home,
    });
    let diag = runner.check_capability(&workspace, &env, false).await;
    assert_eq!(
        diag.status,
        LibreOfficeCheckStatus::Available,
        "{}",
        diag.message
    );
    assert_eq!(diag.version.as_deref(), Some("26.2.3.2"));

    let input = root.join("doc.html");
    std::fs::write(&input, "<html></html>").unwrap();
    let out_dir = root.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let err = runner
        .convert_document(SofficeConvertRequest {
            input_path: input,
            output_dir: out_dir,
            convert_to: "pdf".to_owned(),
            extra_args: Vec::new(),
            cwd: workspace,
            env,
            timeout: Some(Duration::from_secs(10)),
        })
        .await
        .expect_err("conversions must still require an enforcing sandbox");
    assert!(
        matches!(err, cowork_env::EnvError::SofficeSandboxUnenforced(_)),
        "{err:?}"
    );
}
