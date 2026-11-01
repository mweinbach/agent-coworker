//! Skill installation update/copy regressions against the TS `src/skills/operations.ts` reference:
//! updating a disabled managed skill keeps it disabled (same directory, same installation id), and
//! copying a skill onto its own installation directory is rejected before anything is removed.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_harness::extensions::{ExtensionManager, SkillInstallationEntry};
use uuid::Uuid;

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

struct Fixture {
    base: PathBuf,
    home: PathBuf,
    cfg: AgentConfig,
    ext: ExtensionManager,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn fixture(tag: &str) -> Fixture {
    let base = test_temp_base().join(format!("cowork-skill-upd-{tag}-{}", Uuid::new_v4()));
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(base.join("builtin/skills")).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws.clone()),
        homedir: Some(home.clone()),
        built_in_dir: Some(base.join("builtin")),
        env: Some(env.clone()),
    })
    .unwrap();
    Fixture {
        base,
        home,
        cfg,
        ext: ExtensionManager::new(env),
    }
}

fn write_skill(dir: &Path, name: &str, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Test skill {name}\n---\n{body}\n"),
    )
    .unwrap();
}

fn installations_named(fx: &Fixture, name: &str) -> Vec<SkillInstallationEntry> {
    fx.ext
        .collect_skill_installations(&fx.cfg)
        .into_iter()
        .filter(|i| i.name == name)
        .collect()
}

#[tokio::test]
async fn updating_a_disabled_managed_skill_keeps_it_disabled_with_the_same_id() {
    let fx = fixture("disabled");
    let source = fx.base.join("src/notes-helper");
    write_skill(&source, "notes-helper", "Version one.");

    fx.ext
        .install_skill(&fx.cfg, source.to_str().unwrap(), "global")
        .await
        .unwrap();
    let installed = installations_named(&fx, "notes-helper");
    assert_eq!(installed.len(), 1);
    let original = installed[0].clone();
    assert!(original.managed && original.enabled);

    fx.ext
        .set_skill_installation_enabled(&fx.cfg, &original.installation_id, false)
        .unwrap();
    let disabled_root = fx.home.join(".cowork/disabled-skills/notes-helper");
    let enabled_root = fx.home.join(".cowork/skills/notes-helper");
    assert!(disabled_root.join("SKILL.md").is_file());
    assert!(!enabled_root.exists());

    write_skill(&source, "notes-helper", "Version two.");
    let check = fx
        .ext
        .check_skill_installation_update(&fx.cfg, &original.installation_id)
        .await
        .unwrap();
    assert!(check.can_update);

    fx.ext
        .update_skill_installation(&fx.cfg, &original.installation_id)
        .await
        .unwrap();

    // Updated in place inside `disabled-skills/`; never reactivated under `skills/`.
    assert!(
        !enabled_root.exists(),
        "update must not create an enabled installation for a disabled skill"
    );
    let updated_body = fs::read_to_string(disabled_root.join("SKILL.md")).unwrap();
    assert!(updated_body.contains("Version two."), "{updated_body}");

    let after = installations_named(&fx, "notes-helper");
    assert_eq!(after.len(), 1, "exactly one installation must remain");
    let updated = &after[0];
    assert_eq!(updated.installation_id, original.installation_id);
    assert!(!updated.enabled);
    assert_eq!(updated.state, "disabled");
    assert_eq!(updated.scope, "global");
    assert_eq!(updated.installed_at, original.installed_at);
    let new_hash = cowork_harness::extensions::compute_source_root_hash(&source).unwrap();
    assert_eq!(
        updated.installed_source_hash.as_deref(),
        Some(new_hash.as_str())
    );
    // No staging/backup leftovers next to the installation.
    let leftovers: Vec<_> = fs::read_dir(fx.home.join(".cowork/disabled-skills"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "notes-helper")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // A later re-enable keeps the same identity.
    fx.ext
        .set_skill_installation_enabled(&fx.cfg, &original.installation_id, true)
        .unwrap();
    let reenabled = installations_named(&fx, "notes-helper");
    assert_eq!(reenabled.len(), 1);
    assert_eq!(reenabled[0].installation_id, original.installation_id);
    assert!(reenabled[0].enabled);
}

#[tokio::test]
async fn updating_an_enabled_managed_skill_keeps_its_id() {
    let fx = fixture("enabled");
    let source = fx.base.join("src/notes-helper");
    write_skill(&source, "notes-helper", "Version one.");
    fx.ext
        .install_skill(&fx.cfg, source.to_str().unwrap(), "project")
        .await
        .unwrap();
    let original = installations_named(&fx, "notes-helper").remove(0);

    write_skill(&source, "notes-helper", "Version two.");
    fx.ext
        .update_skill_installation(&fx.cfg, &original.installation_id)
        .await
        .unwrap();
    let after = installations_named(&fx, "notes-helper");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].installation_id, original.installation_id);
    assert!(after[0].enabled);
    assert_eq!(after[0].root_dir, original.root_dir);
    let body = fs::read_to_string(Path::new(&after[0].root_dir).join("SKILL.md")).unwrap();
    assert!(body.contains("Version two."));
}

#[tokio::test]
async fn updating_rejects_read_only_and_unmanaged_installations() {
    let fx = fixture("reject-update");
    // Unmanaged writable skill (no `.cowork-skill.json`): no recorded update source.
    write_skill(
        &fx.home.join(".cowork/skills/hand-made"),
        "hand-made",
        "Body.",
    );
    let unmanaged = installations_named(&fx, "hand-made").remove(0);
    assert!(!unmanaged.managed);
    let err = fx
        .ext
        .update_skill_installation(&fx.cfg, &unmanaged.installation_id)
        .await
        .unwrap_err();
    assert_eq!(err, "No update source is recorded for this installation");
    assert!(fx.home.join(".cowork/skills/hand-made/SKILL.md").is_file());

    // Built-in skills are read-only.
    write_skill(&fx.base.join("builtin/skills/stock"), "stock", "Body.");
    let builtin = installations_named(&fx, "stock").remove(0);
    let err = fx
        .ext
        .update_skill_installation(&fx.cfg, &builtin.installation_id)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "This installation is read-only and cannot be updated directly"
    );
}

#[test]
fn copying_a_skill_into_its_own_scope_is_rejected_without_deleting_it() {
    let fx = fixture("copy-same");
    let root = fx.home.join(".cowork/skills/notes-helper");
    write_skill(&root, "notes-helper", "Keep me.");
    let entry = installations_named(&fx, "notes-helper").remove(0);
    assert_eq!(entry.scope, "global");

    let err = fx
        .ext
        .copy_skill_installation(&fx.cfg, &entry.installation_id, "global", true)
        .unwrap_err();
    assert_eq!(
        err,
        "Cannot copy \"notes-helper\" into the global scope because it already lives there; that would delete the source before copying."
    );
    assert_eq!(
        fs::read_to_string(root.join("SKILL.md")).unwrap(),
        "---\nname: notes-helper\ndescription: Test skill notes-helper\n---\nKeep me.\n"
    );
}

#[cfg(unix)]
#[test]
fn copying_onto_an_aliased_copy_of_the_source_directory_is_rejected() {
    let fx = fixture("copy-alias");
    // `~/.agents/skills` (user scope) is a symlink to `~/.cowork/skills` (global scope), so the
    // user-scope installation and the global copy destination are the same directory.
    let global_skills = fx.home.join(".cowork/skills");
    let root = global_skills.join("notes-helper");
    write_skill(&root, "notes-helper", "Keep me.");
    fs::create_dir_all(fx.home.join(".agents")).unwrap();
    std::os::unix::fs::symlink(&global_skills, fx.home.join(".agents/skills")).unwrap();

    let user_entry = installations_named(&fx, "notes-helper")
        .into_iter()
        .find(|i| i.scope == "user")
        .expect("user-scope alias installation");

    let err = fx
        .ext
        .copy_skill_installation(&fx.cfg, &user_entry.installation_id, "global", true)
        .unwrap_err();
    assert!(err.contains("already lives there"), "{err}");
    assert!(root.join("SKILL.md").is_file(), "source must survive");
}

#[test]
fn copying_into_another_scope_still_works_and_replaces_existing_copy() {
    let fx = fixture("copy-ok");
    let builtin_root = fx.base.join("builtin/skills/stock");
    write_skill(&builtin_root, "stock", "Built-in body.");
    let entry = installations_named(&fx, "stock").remove(0);
    assert!(!entry.writable);

    let dst = fx.cfg.project_cowork_dir.join("skills/stock");
    write_skill(&dst, "stock", "Stale copy.");
    fx.ext
        .copy_skill_installation(&fx.cfg, &entry.installation_id, "project", true)
        .unwrap();
    let body = fs::read_to_string(dst.join("SKILL.md")).unwrap();
    assert!(body.contains("Built-in body."), "{body}");
    assert!(dst.join(".cowork-skill.json").is_file());
    assert!(builtin_root.join("SKILL.md").is_file());
    let leftovers: Vec<_> = fs::read_dir(fx.cfg.project_cowork_dir.join("skills"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "stock")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
