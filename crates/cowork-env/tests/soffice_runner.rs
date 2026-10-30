use std::collections::{HashMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_env::{
    LibreOfficeCheckStatus, PdftoppmJobRequest, SofficeConvertRequest, SofficeRunner,
    SofficeRunnerConfig, validate_soffice_args,
};
use cowork_sandbox::SandboxManager;
use parking_lot::Mutex;
use tempfile::TempDir;

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/private/tmp")
        .expect("create tempdir in /private/tmp");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

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
    // 1. Verifies `--headless` and `-env:UserInstallation=file:///private/tmp/...` were injected,
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
if [[ "$profile_url" != file:///private/tmp/* ]]; then
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
    write_executable(&soffice_bin, soffice_script);

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
sleep 60 &
grandchild_pid=$!
echo "$grandchild_pid" > "${outdir}/grandchild.pid"
echo "$profile_dir" > "${outdir}/profile.path"
wait "$grandchild_pid"
"#;
    write_executable(&soffice_bin, hung_script);

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
        for _ in 0..20 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(
            !alive,
            "orphaned grandchild process {pid} survived soffice timeout!"
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
