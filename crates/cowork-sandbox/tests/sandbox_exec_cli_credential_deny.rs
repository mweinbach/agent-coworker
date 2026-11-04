//! `cowork-server __sandbox-exec` must hide the default credential set from the wrapped command
//! in both the `--json-result` and the transparent execution branches (PR #389 review).

use std::collections::HashMap;
use std::path::PathBuf;

use cowork_config::canonicalize_sync;
use cowork_sandbox::cli::default_credential_read_denied_roots;

#[test]
fn default_credential_deny_set_covers_cowork_auth_pairing_and_cloud_stores() {
    let tmp = tempfile::tempdir().unwrap();
    let home = canonicalize_sync(&tmp.path().join("home"));
    let cwd = canonicalize_sync(&tmp.path().join("work"));
    let env = HashMap::from([("HOME".to_owned(), home.to_string_lossy().into_owned())]);

    let roots = default_credential_read_denied_roots(&env, "linux", &cwd);
    let mut expected: Vec<PathBuf> = vec![
        home.join(".cowork").join("auth"),
        home.join(".cowork").join("mobile-pairing"),
        cwd.join(".cowork").join("auth"),
    ];
    for dir in [".ssh", ".aws", ".gnupg", ".kube", ".azure"] {
        expected.push(home.join(dir));
    }
    assert_eq!(roots, expected);
}

#[test]
fn cowork_home_override_does_not_unhide_the_real_home_credentials() {
    let tmp = tempfile::tempdir().unwrap();
    let home = canonicalize_sync(&tmp.path().join("home"));
    let override_home = canonicalize_sync(&tmp.path().join("override"));
    let cwd = canonicalize_sync(&tmp.path().join("work"));
    let env = HashMap::from([
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        (
            "COWORK_HOME_OVERRIDE".to_owned(),
            override_home.to_string_lossy().into_owned(),
        ),
    ]);

    let roots = default_credential_read_denied_roots(&env, "linux", &cwd);
    for base in [&home, &override_home] {
        for required in [
            base.join(".cowork").join("auth"),
            base.join(".cowork").join("mobile-pairing"),
            base.join(".ssh"),
            base.join(".aws"),
            base.join(".gnupg"),
            base.join(".kube"),
            base.join(".azure"),
        ] {
            assert!(
                roots.contains(&required),
                "missing {required:?} in {roots:?}"
            );
        }
    }
    assert!(roots.contains(&cwd.join(".cowork").join("auth")));
    let mut deduped = roots.clone();
    deduped.dedup();
    assert_eq!(deduped.len(), roots.len());
}

#[test]
fn windows_user_profile_is_covered() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = canonicalize_sync(&tmp.path().join("profile"));
    let cwd = canonicalize_sync(&tmp.path().join("work"));
    let env = HashMap::from([(
        "USERPROFILE".to_owned(),
        profile.to_string_lossy().into_owned(),
    )]);
    let roots = default_credential_read_denied_roots(&env, "win32", &cwd);
    assert!(roots.contains(&profile.join(".ssh")), "{roots:?}");
    assert!(
        roots.contains(&profile.join(".cowork").join("auth")),
        "{roots:?}"
    );
}
