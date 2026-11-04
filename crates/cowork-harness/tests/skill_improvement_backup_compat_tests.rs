//! On-disk compatibility of skill-improvement backups with the TypeScript app:
//! `originals/<key>.meta.json` sidecars, registry recovery from a corrupt `state.json`,
//! `path.resolve`-based (non-realpath) backup keys for symlinked skill dirs, and restore
//! semantics when a duplicate backup of an already-improved skill exists.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use cowork_config::{
    AgentConfig, LoadConfigOptions, SkillImprovementScope, canonicalize_sync, load_config,
};
use cowork_harness::skill_improvement::{
    CompletedTurnSkillUsage, CompletedTurnSkillUsageInput, ConfinedSkillDirectoryEditor,
    SkillImprovementService, SkillImprovementServiceDeps, SkillImproverRunInput,
    SkillImproverRunResult, SkillImproverRunner, skill_improvement_backup_key,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const ORIGINAL_MD: &str = "---\nname: foo\ndescription: Foo helper\n---\nOriginal body.\n";
const TS_IMPROVED_MD: &str =
    "---\nname: foo\ndescription: Foo helper\n---\nOriginal body.\n\n## TS tip\nImproved by TS.\n";

fn test_temp_base() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    }
}

fn canonical_temp_dir(prefix: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(test_temp_base())
        .expect("create tempdir");
    let canonical = canonicalize_sync(dir.path());
    (dir, canonical)
}

/// TS `backupKeyForSkill` for an already-resolved absolute path:
/// `${sanitizeSegment(name)}-${sha256(path.resolve(root)).hex.slice(0, 16)}`
/// (equivalent to `printf '%s' <path> | sha256sum | cut -c1-16`).
fn ts_backup_key(sanitized_name: &str, resolved_root: &str) -> String {
    let digest = hex::encode(Sha256::digest(resolved_root.as_bytes()));
    format!("{sanitized_name}-{}", &digest[..16])
}

/// A copy-back record serialized exactly like TS `JSON.stringify(record, null, 2) + "\n"`
/// (TS object key order, 2-space indent, trailing newline).
fn ts_copy_back_sidecar(
    key: &str,
    source_root_dir: &str,
    backup_root_dir: &str,
    created_at: &str,
) -> String {
    let q = |v: &str| serde_json::to_string(v).unwrap();
    format!(
        "{{\n  \"key\": {},\n  \"skillName\": \"foo\",\n  \"sourceRootDir\": {},\n  \"backupRootDir\": {},\n  \"createdAt\": {},\n  \"restoreMode\": \"copy-back\"\n}}\n",
        q(key),
        q(source_root_dir),
        q(backup_root_dir),
        q(created_at)
    )
}

struct Fixture {
    _guard: TempDir,
    home: PathBuf,
    ws: PathBuf,
    cfg: AgentConfig,
    env: HashMap<String, String>,
}

impl Fixture {
    fn new(prefix: &str) -> Self {
        let (guard, base) = canonical_temp_dir(prefix);
        let home = base.join("home");
        let ws = base.join("workspace");
        let cowork_home = home.join(".cowork");
        fs::create_dir_all(cowork_home.join("config")).unwrap();
        fs::create_dir_all(cowork_home.join("skills")).unwrap();
        fs::create_dir_all(ws.join(".cowork/skills")).unwrap();
        let builtin = base.join("builtin");
        fs::create_dir_all(builtin.join("skills")).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".to_owned(),
            cowork_home.to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());

        let mut cfg = load_config(LoadConfigOptions {
            cwd: Some(ws.clone()),
            homedir: Some(home.clone()),
            built_in_dir: Some(builtin),
            env: Some(env.clone()),
        })
        .unwrap();
        cfg.skill_improvement_enabled = true;
        cfg.skill_improvement_scope = SkillImprovementScope::All;
        Self {
            _guard: guard,
            home,
            ws,
            cfg,
            env,
        }
    }

    fn global_skills_dir(&self) -> PathBuf {
        self.home.join(".cowork/skills")
    }

    fn improvement_root(&self) -> PathBuf {
        self.home.join(".cowork/skill-improvement")
    }

    fn service(&self) -> SkillImprovementService {
        let cfg = self.cfg.clone();
        SkillImprovementService::new(SkillImprovementServiceDeps {
            cowork_home: self.home.join(".cowork"),
            env: self.env.clone(),
            load_config: Arc::new(move |_cwd| Ok(cfg.clone())),
            has_busy_sessions: Arc::new(|| false),
            signal_skill_mutation: Arc::new(|| {}),
            broadcast_status: None,
            improver: Some(Arc::new(AppendTipImprover)),
        })
    }

    async fn improve(&self, svc: &SkillImprovementService, skill_dir: &Path, turn: &str) {
        svc.record_completed_turn_usage(CompletedTurnSkillUsage {
            session_id: "s1".to_owned(),
            turn_id: turn.to_owned(),
            working_directory: self.ws.to_string_lossy().into_owned(),
            message_start_index: 0,
            message_end_index: 2,
            transcript: "User invoked foo.".to_owned(),
            usages: vec![CompletedTurnSkillUsageInput {
                skill_name: "foo".to_owned(),
                kind: "tool".to_owned(),
                source: "skill".to_owned(),
                turn_id: turn.to_owned(),
                used_at: "2026-03-20T10:00:00.000Z".to_owned(),
                skill_source: Some("global".to_owned()),
                skill_path: Some(skill_dir.join("SKILL.md").to_string_lossy().into_owned()),
            }],
        })
        .expect("record usage");
        svc.run_now(Some("foo"), Some(&self.ws))
            .await
            .expect("run_now foo");
    }

    /// Writes a TS-made backup: `originals/<key>/` holding `ORIGINAL_MD`, its sidecar, and
    /// returns the TS record JSON.
    fn write_ts_backup(&self, key: &str, source_root_dir: &str, created_at: &str) -> Value {
        let originals = self.improvement_root().join("originals");
        let backup_root = originals.join(key);
        fs::create_dir_all(&backup_root).unwrap();
        fs::write(backup_root.join("SKILL.md"), ORIGINAL_MD).unwrap();
        let sidecar = ts_copy_back_sidecar(
            key,
            source_root_dir,
            &backup_root.to_string_lossy(),
            created_at,
        );
        fs::write(originals.join(format!("{key}.meta.json")), &sidecar).unwrap();
        serde_json::from_str(&sidecar).unwrap()
    }

    fn write_state(&self, backups: &[Value]) {
        let mut map = serde_json::Map::new();
        for b in backups {
            map.insert(b["key"].as_str().unwrap().to_owned(), b.clone());
        }
        let state = json!({
            "version": 1,
            "pendingJobs": {},
            "runHistory": [],
            "backups": Value::Object(map),
        });
        fs::create_dir_all(self.improvement_root()).unwrap();
        fs::write(
            self.improvement_root().join("state.json"),
            format!("{}\n", serde_json::to_string_pretty(&state).unwrap()),
        )
        .unwrap();
    }

    fn originals_entries(&self) -> BTreeSet<String> {
        fs::read_dir(self.improvement_root().join("originals"))
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
}

struct AppendTipImprover;

#[async_trait]
impl SkillImproverRunner for AppendTipImprover {
    async fn run(
        &self,
        _cfg: &AgentConfig,
        input: SkillImproverRunInput,
    ) -> SkillImproverRunResult {
        let editor = ConfinedSkillDirectoryEditor::open(&input.skill_root_dir).unwrap();
        let current = editor.read_file("SKILL.md").unwrap();
        editor
            .write_file(
                "SKILL.md",
                &format!("{current}\n## Rust tip\nImproved by Rust.\n"),
            )
            .unwrap();
        SkillImproverRunResult {
            ok: true,
            changed: true,
            message: "Added tip.".to_owned(),
            error: None,
        }
    }
}

#[cfg(unix)]
#[test]
fn backup_key_matches_ts_path_resolve_sha256() {
    // Reference values computed with the TS `backupKeyForSkill` under Node 22
    // (`printf '%s' /home/u/.cowork/skills/foo | sha256sum` -> 29d74fdca4a12b13...).
    assert_eq!(
        skill_improvement_backup_key("foo", Path::new("/home/u/.cowork/skills/foo")),
        "foo-29d74fdca4a12b13"
    );
    // `path.resolve` normalizes `.`/`..` and the trailing slash lexically.
    assert_eq!(
        skill_improvement_backup_key("foo", Path::new("/home/u/.cowork/skills/./bar/../foo/")),
        "foo-29d74fdca4a12b13"
    );
    // Repeated separators collapse; the name is sanitized like TS `sanitizeSegment`.
    assert_eq!(
        skill_improvement_backup_key("My Skill!", Path::new("/home/u//x/skills/my-skill")),
        "my-skill-5cac229933c0eea8"
    );
    // A literal `-` next to a disallowed run is kept (`"a-!b"` -> `"a--b"` in TS).
    assert!(
        skill_improvement_backup_key("a-!b", Path::new("/x")).starts_with("a--b-"),
        "sanitize must replace each disallowed run with one dash without merging literal dashes"
    );
    // Relative paths resolve against the cwd.
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        skill_improvement_backup_key("foo", Path::new("rel/foo")),
        ts_backup_key("foo", &cwd.join("rel/foo").to_string_lossy())
    );
}

#[tokio::test]
async fn register_backup_writes_ts_sidecar_and_corrupt_state_rebuilds_registry() {
    let fx = Fixture::new("cowork-skill-imp-sidecar-");
    let skill_dir = fx.global_skills_dir().join("foo");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), ORIGINAL_MD).unwrap();

    let svc = fx.service();
    fx.improve(&svc, &skill_dir, "t1").await;
    assert!(
        fs::read_to_string(skill_dir.join("SKILL.md"))
            .unwrap()
            .contains("Improved by Rust.")
    );

    let state = svc.store().read();
    assert_eq!(state.backups.len(), 1);
    let record = state.backups.values().next().unwrap().clone();
    assert_eq!(
        record.key,
        ts_backup_key("foo", &skill_dir.to_string_lossy())
    );

    // Sidecar is byte-for-byte the TS format: `JSON.stringify(record, null, 2) + "\n"`.
    let sidecar_path = svc.store().backup_meta_path(&record.key);
    assert_eq!(
        sidecar_path,
        fx.improvement_root()
            .join("originals")
            .join(format!("{}.meta.json", record.key))
    );
    let sidecar_raw = fs::read_to_string(&sidecar_path).expect("sidecar written");
    assert_eq!(
        sidecar_raw,
        ts_copy_back_sidecar(
            &record.key,
            &skill_dir.to_string_lossy(),
            &fx.improvement_root()
                .join("originals")
                .join(&record.key)
                .to_string_lossy(),
            &record.created_at,
        )
    );
    let sidecar_keys: BTreeSet<String> = serde_json::from_str::<Value>(&sidecar_raw)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        sidecar_keys,
        [
            "backupRootDir",
            "createdAt",
            "key",
            "restoreMode",
            "skillName",
            "sourceRootDir"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
    );

    // Partly written state.json: the registry is rebuilt from the sidecar.
    fs::write(
        fx.improvement_root().join("state.json"),
        "{\"version\":1,\"pendingJobs\":{",
    )
    .unwrap();
    let status = svc.get_status(None, Some(&fx.ws)).expect("status");
    assert!(
        status
            .skills
            .iter()
            .any(|s| s.skill_name == "foo" && s.has_backup)
    );
    assert_eq!(status.backups, vec![record.clone()]);
    // The corrupt file was parked by that read; later reads still see the backup.
    assert!(!fx.improvement_root().join("state.json").exists());
    assert_eq!(svc.store().read().backups.get(&record.key), Some(&record));

    svc.restore("foo", Some(&fx.ws)).await.expect("restore");
    assert_eq!(
        fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
        ORIGINAL_MD
    );
    assert!(!sidecar_path.exists(), "sidecar retired with its backup");
    assert!(
        fx.originals_entries().is_empty(),
        "originals/<key>/ retired"
    );
    assert!(svc.store().read().backups.is_empty());
}

#[tokio::test]
async fn ts_sidecar_restores_original_after_state_json_corruption() {
    let fx = Fixture::new("cowork-skill-imp-ts-sidecar-");
    let skill_dir = fx.global_skills_dir().join("foo");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), TS_IMPROVED_MD).unwrap();
    let key = ts_backup_key("foo", &skill_dir.to_string_lossy());
    fx.write_ts_backup(
        &key,
        &skill_dir.to_string_lossy(),
        "2026-01-02T03:04:05.678Z",
    );
    fs::write(fx.improvement_root().join("state.json"), "not json at all").unwrap();

    let svc = fx.service();
    svc.restore("foo", Some(&fx.ws))
        .await
        .expect("restore from TS sidecar after corruption");
    assert_eq!(
        fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
        ORIGINAL_MD
    );
    assert!(fx.originals_entries().is_empty());
    assert!(svc.store().read().backups.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_skill_dir_reuses_ts_backup_key_without_second_snapshot() {
    let fx = Fixture::new("cowork-skill-imp-symlink-");
    let real_dir = fx.home.join("dotfiles/foo");
    fs::create_dir_all(&real_dir).unwrap();
    fs::write(real_dir.join("SKILL.md"), TS_IMPROVED_MD).unwrap();
    let link_dir = fx.global_skills_dir().join("foo");
    std::os::unix::fs::symlink(&real_dir, &link_dir).unwrap();

    // TS keyed and recorded the lexical `path.resolve` path, not the realpath.
    let lexical = link_dir.to_string_lossy().into_owned();
    let ts_key = ts_backup_key("foo", &lexical);
    assert_ne!(ts_key, ts_backup_key("foo", &real_dir.to_string_lossy()));
    assert_eq!(skill_improvement_backup_key("foo", &link_dir), ts_key);
    let created_at = "2026-01-02T03:04:05.678Z";
    let ts_record = fx.write_ts_backup(&ts_key, &lexical, created_at);
    fx.write_state(&[ts_record]);

    let svc = fx.service();
    fx.improve(&svc, &link_dir, "t1").await;
    fx.improve(&svc, &link_dir, "t2").await;

    let state = svc.store().read();
    assert_eq!(
        state.backups.keys().cloned().collect::<Vec<_>>(),
        vec![ts_key.clone()],
        "the TS backup is reused; no second snapshot of improved content"
    );
    let record = &state.backups[&ts_key];
    assert_eq!(record.created_at, created_at);
    assert_eq!(record.source_root_dir, lexical);
    assert_eq!(
        fx.originals_entries(),
        [ts_key.clone(), format!("{ts_key}.meta.json")]
            .into_iter()
            .collect::<BTreeSet<_>>()
    );
    assert_eq!(
        fs::read_to_string(
            fx.improvement_root()
                .join("originals")
                .join(&ts_key)
                .join("SKILL.md")
        )
        .unwrap(),
        ORIGINAL_MD,
        "stored original untouched"
    );
    let live = fs::read_to_string(link_dir.join("SKILL.md")).unwrap();
    assert!(live.contains("Improved by TS.") && live.contains("Improved by Rust."));

    svc.restore("foo", Some(&fx.ws)).await.expect("restore");
    assert_eq!(
        fs::read_to_string(link_dir.join("SKILL.md")).unwrap(),
        ORIGINAL_MD
    );
    assert!(fx.originals_entries().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn fresh_symlinked_skill_backup_uses_lexical_key() {
    let fx = Fixture::new("cowork-skill-imp-symlink-fresh-");
    let real_dir = fx.home.join("dotfiles/foo");
    fs::create_dir_all(&real_dir).unwrap();
    fs::write(real_dir.join("SKILL.md"), ORIGINAL_MD).unwrap();
    let link_dir = fx.global_skills_dir().join("foo");
    std::os::unix::fs::symlink(&real_dir, &link_dir).unwrap();

    let svc = fx.service();
    fx.improve(&svc, &link_dir, "t1").await;
    fx.improve(&svc, &link_dir, "t2").await;

    let state = svc.store().read();
    let lexical = link_dir.to_string_lossy().into_owned();
    let expected_key = ts_backup_key("foo", &lexical);
    assert_eq!(
        state.backups.keys().cloned().collect::<Vec<_>>(),
        vec![expected_key.clone()]
    );
    assert_eq!(state.backups[&expected_key].source_root_dir, lexical);

    svc.restore("foo", Some(&fx.ws)).await.expect("restore");
    assert_eq!(
        fs::read_to_string(link_dir.join("SKILL.md")).unwrap(),
        ORIGINAL_MD
    );
}

#[cfg(unix)]
#[tokio::test]
async fn restore_yields_true_original_when_realpath_duplicate_backup_exists() {
    let fx = Fixture::new("cowork-skill-imp-dup-");
    let real_dir = fx.home.join("dotfiles/foo");
    fs::create_dir_all(&real_dir).unwrap();
    let link_dir = fx.global_skills_dir().join("foo");
    std::os::unix::fs::symlink(&real_dir, &link_dir).unwrap();
    let improved_twice = format!("{TS_IMPROVED_MD}\n## Rust tip\nImproved by Rust.\n");
    fs::write(real_dir.join("SKILL.md"), &improved_twice).unwrap();

    // TS backup of the true original (lexical path), created first.
    let lexical = link_dir.to_string_lossy().into_owned();
    let ts_key = ts_backup_key("foo", &lexical);
    let ts_record = fx.write_ts_backup(&ts_key, &lexical, "2026-01-02T03:04:05.678Z");

    // An older Rust build then snapshotted the already TS-improved skill under a
    // realpath-derived key. The key is chosen to sort after the TS key, which is the
    // order that made key-ordered restore end on the improved copy.
    let dup_key = "foo-ffffffffffffffff".to_owned();
    assert!(dup_key > ts_key);
    let dup_root = fx.improvement_root().join("originals").join(&dup_key);
    fs::create_dir_all(&dup_root).unwrap();
    fs::write(dup_root.join("SKILL.md"), TS_IMPROVED_MD).unwrap();
    let dup_sidecar = ts_copy_back_sidecar(
        &dup_key,
        &real_dir.to_string_lossy(),
        &dup_root.to_string_lossy(),
        "2026-05-06T07:08:09.000Z",
    );
    fs::write(
        fx.improvement_root()
            .join("originals")
            .join(format!("{dup_key}.meta.json")),
        &dup_sidecar,
    )
    .unwrap();
    let dup_record: Value = serde_json::from_str(&dup_sidecar).unwrap();
    fx.write_state(&[ts_record, dup_record]);

    let svc = fx.service();
    // Another improvement must not mint a third snapshot.
    fx.improve(&svc, &link_dir, "t1").await;
    assert_eq!(
        svc.store()
            .read()
            .backups
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        [ts_key.clone(), dup_key.clone()]
            .into_iter()
            .collect::<BTreeSet<_>>()
    );

    svc.restore("foo", Some(&fx.ws)).await.expect("restore");
    assert_eq!(
        fs::read_to_string(link_dir.join("SKILL.md")).unwrap(),
        ORIGINAL_MD,
        "restore yields the pre-TS original, not the TS-improved duplicate"
    );
    assert!(svc.store().read().backups.is_empty());
    assert!(
        fx.originals_entries().is_empty(),
        "both backup dirs and sidecars are retired"
    );
}
