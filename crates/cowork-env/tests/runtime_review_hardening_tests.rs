//! Regression tests for PR #389 review findings on the runtime installer / integrity / archive /
//! manifest layer:
//! - `.sha256` lines naming another asset are never used (TS `checksumFromText`);
//! - `pack.json` is read with a byte cap before signature verification;
//! - no fallback onto an older cached runtime under `COWORK_RUNTIME_FORCE=1` or an explicit
//!   `COWORK_RUNTIME_VERSION`;
//! - case-insensitive symlink graph validation and dangling external symlink targets;
//! - `runtime.json` `paths.*` must stay inside the runtime root;
//! - v2 trusted symlinks come from signed `pack.json`, never from the unsigned `runtime.json`.

// Runtime fixtures use POSIX executables, modes and symlinks.
#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use cowork_config::canonicalize_sync;
use cowork_env::{
    EnsureRuntimeOptions, PreparedRuntime, RuntimeInstallOptions, RuntimeIntegrityManifest,
    RuntimeManifestPaths, RuntimePackId, RuntimePaths, RuntimeSignatureEnvelope, TrustedKeyRing,
    build_signed_v1_zip_fixture, build_signed_v2_pack_tar_zst_fixture, checksum_from_text,
    ensure_cowork_runtime_ready, extract_v2_tar_zst_archive, install_v1_zip_runtime,
    install_v2_pack_set, resolve_host_asset, unseal_tree_for_removal, verify_installed_runtime,
};
use ed25519_dalek::{Signer, SigningKey};

const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STALE_VERSION: &str = "2026-01-01";
const V2_VERSION: &str = "2026-07-01";

fn test_keypair() -> (String, SigningKey, TrustedKeyRing) {
    let key_id = "test-runtime-key-1".to_owned();
    let signing_key = SigningKey::from_bytes(&[0x42_u8; 32]);
    let mut ring = TrustedKeyRing::with_official_defaults();
    ring.insert_verifying_key(key_id.clone(), signing_key.verifying_key());
    (key_id, signing_key, ring)
}

fn write_executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn populate_staging(staging: &Path) {
    write_executable(
        &staging.join("dependencies/node/bin/node"),
        "#!/bin/sh\necho v22.12.0\n",
    );
    write_executable(
        &staging.join("dependencies/python/bin/python3"),
        "#!/bin/sh\necho Python 3.12.0\n",
    );
    write_executable(&staging.join("dependencies/bin/uv"), "#!/bin/sh\nexit 0\n");
    std::fs::create_dir_all(staging.join("cowork/node-resolver")).unwrap();
    std::fs::write(
        staging.join("cowork/node-resolver/register.mjs"),
        "export const ok = true;\n",
    )
    .unwrap();
}

fn tempdir(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = canonicalize_sync(tmp.path());
    (tmp, root)
}

// ---------------------------------------------------------------------------------------------
// A) checksum_from_text
// ---------------------------------------------------------------------------------------------

#[test]
fn checksum_lines_naming_another_asset_are_never_used() {
    let err = checksum_from_text(&format!("{DIGEST_A}  other-asset.zip\n"), "mine.zip")
        .expect_err("a digest for a different asset must be rejected");
    assert!(err.to_string().contains("other-asset.zip"), "{err}");

    // The named match wins over earlier lines for other assets.
    let text = format!("{DIGEST_A}  other-asset.zip\n{DIGEST_B} *mine.zip\n");
    assert_eq!(checksum_from_text(&text, "mine.zip").unwrap(), DIGEST_B);

    // A bare digest (no filename token) still applies.
    assert_eq!(
        checksum_from_text(&format!("{DIGEST_B}\n"), "mine.zip").unwrap(),
        DIGEST_B
    );
    let text = format!("{DIGEST_A}  other-asset.zip\n{DIGEST_B}\n");
    assert_eq!(checksum_from_text(&text, "mine.zip").unwrap(), DIGEST_B);
}

// ---------------------------------------------------------------------------------------------
// A) pack.json byte cap ahead of signature verification
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn oversized_pack_json_is_rejected_before_signature_verification() {
    let (_tmp, root) = tempdir("cowork-pack-json-cap-");
    let archive = root.join("cowork-runtime-core.tar.zst");
    {
        let file = std::fs::File::create(&archive).unwrap();
        let encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
        let mut builder = tar::Builder::new(encoder);
        let body = vec![b' '; 1024 * 1024 + 16];
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        builder
            .append_data(&mut header, "pack.json", body.as_slice())
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
    let sha = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(std::fs::read(&archive).unwrap()))
    };
    let (_, _, trusted_keys) = test_keypair();
    let err = ensure_cowork_runtime_ready(EnsureRuntimeOptions {
        homedir: root.join("home"),
        env: HashMap::from([
            (
                "COWORK_RUNTIME_ARCHIVE_PATH".to_owned(),
                archive.to_string_lossy().into_owned(),
            ),
            ("COWORK_RUNTIME_ARCHIVE_SHA256".to_owned(), sha),
        ]),
        trusted_keys,
        on_progress: None,
    })
    .await
    .expect_err("an oversized pack.json must be rejected");
    assert!(err.to_string().contains("pack.json exceeds"), "{err}");
}

// ---------------------------------------------------------------------------------------------
// D) No fallback onto an older cached runtime for --force / explicit versions
// ---------------------------------------------------------------------------------------------

struct V1Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    staging: PathBuf,
    asset: String,
    key_id: String,
    signing_key: SigningKey,
    trusted_keys: TrustedKeyRing,
}

impl V1Fixture {
    fn new(prefix: &str) -> Self {
        let (tmp, root) = tempdir(prefix);
        let staging = root.join("staging");
        populate_staging(&staging);
        std::fs::create_dir_all(staging.join("node_modules/@oai/artifact-tool")).unwrap();
        std::fs::write(
            staging.join("node_modules/@oai/artifact-tool/index.js"),
            "module.exports = {};\n",
        )
        .unwrap();
        let (key_id, signing_key, trusted_keys) = test_keypair();
        Self {
            home: root.join("home"),
            staging,
            asset: resolve_host_asset().unwrap(),
            root,
            _tmp: tmp,
            key_id,
            signing_key,
            trusted_keys,
        }
    }

    fn install(&self, version: &str) -> PreparedRuntime {
        let zip_path = self.root.join(format!("rt-{version}.zip"));
        build_signed_v1_zip_fixture(
            &self.staging,
            version,
            &self.asset,
            &self.key_id,
            &self.signing_key,
            &zip_path,
        )
        .unwrap();
        install_v1_zip_runtime(
            &zip_path,
            &RuntimeInstallOptions {
                homedir: self.home.clone(),
                trusted_keys: self.trusted_keys.clone(),
                expected_version: Some(version.to_owned()),
                expected_archive_sha256: None,
                force: false,
                keep_versions: 10,
                on_progress: None,
            },
        )
        .unwrap()
    }

    async fn ensure(&self, env: HashMap<String, String>) -> cowork_env::Result<PreparedRuntime> {
        ensure_cowork_runtime_ready(EnsureRuntimeOptions {
            homedir: self.home.clone(),
            env,
            trusted_keys: self.trusted_keys.clone(),
            on_progress: None,
        })
        .await
    }
}

/// Network-enabled env whose release download always fails (nothing listens on port 9).
fn failing_download_env() -> HashMap<String, String> {
    HashMap::from([
        ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "1".to_owned()),
        (
            "COWORK_RUNTIME_REPOSITORY".to_owned(),
            "acme/cowork-runtime".to_owned(),
        ),
        (
            "COWORK_RUNTIME_RELEASE_TAG".to_owned(),
            "target-release".to_owned(),
        ),
        (
            "COWORK_RUNTIME_BASE_URL".to_owned(),
            "http://127.0.0.1:9".to_owned(),
        ),
    ])
}

#[tokio::test]
async fn forced_reinstall_does_not_fall_back_to_a_cached_runtime() {
    let f = V1Fixture::new("cowork-rt-force-no-fallback-");
    f.install(STALE_VERSION);
    let mut env = failing_download_env();
    env.insert("COWORK_RUNTIME_FORCE".to_owned(), "1".to_owned());
    let err = f
        .ensure(env)
        .await
        .expect_err("--force must surface the install failure, not reuse the cached runtime");
    assert!(
        !matches!(err, cowork_env::EnvError::RuntimeDisabled),
        "{err:?}"
    );

    // Without --force the same failure still recovers onto the cached runtime.
    let prepared = f.ensure(failing_download_env()).await.unwrap();
    assert_eq!(prepared.version, STALE_VERSION);
}

#[tokio::test]
async fn explicit_runtime_version_does_not_fall_back_to_another_version() {
    let f = V1Fixture::new("cowork-rt-explicit-no-fallback-");
    f.install(STALE_VERSION);

    let mut env = failing_download_env();
    env.insert("COWORK_RUNTIME_VERSION".to_owned(), V2_VERSION.to_owned());
    f.ensure(env)
        .await
        .expect_err("an explicit version must not be satisfied by an older cached runtime");

    let env = HashMap::from([
        ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
        ("COWORK_RUNTIME_VERSION".to_owned(), V2_VERSION.to_owned()),
    ]);
    f.ensure(env)
        .await
        .expect_err("offline with an explicit version must not fall back either");

    // The explicitly requested version is still reused when it is the one installed.
    let env = HashMap::from([
        ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
        (
            "COWORK_RUNTIME_VERSION".to_owned(),
            STALE_VERSION.to_owned(),
        ),
    ]);
    assert_eq!(f.ensure(env).await.unwrap().version, STALE_VERSION);
}

// ---------------------------------------------------------------------------------------------
// Archive: case-folded symlink graph + dangling external targets (comment 4460515751)
// ---------------------------------------------------------------------------------------------

#[test]
fn case_folded_symlink_graph_rejects_aliased_parent_escape() {
    // On a case-insensitive filesystem `r/A/B -> ..` makes `r/a/b/escape` land at `r/escape`,
    // where `../../outside` leaves the runtime root.
    let links = HashMap::from([
        ("r/A/B".to_owned(), "..".to_owned()),
        ("r/a/b/escape".to_owned(), "../../outside".to_owned()),
    ]);
    let err = cowork_env::archive::validate_symlink_graph_with_case_folding(&links, true)
        .expect_err("case-folded graph must detect the escape");
    assert!(err.to_string().contains("escapes"), "{err}");
    // Case-sensitive hosts keep `r/A/B` and `r/a/b` distinct, so the same graph is safe there.
    cowork_env::archive::validate_symlink_graph_with_case_folding(&links, false).unwrap();

    // Links that only differ by case collide when folding.
    let dupes = HashMap::from([
        ("r/Link".to_owned(), "x".to_owned()),
        ("r/link".to_owned(), "y".to_owned()),
    ]);
    cowork_env::archive::validate_symlink_graph_with_case_folding(&dupes, true)
        .expect_err("case-insensitive duplicate symlinks must be rejected");
}

#[test]
fn symlink_nested_under_another_symlink_resolves_from_its_physical_parent() {
    // Even case-sensitively, `r/A/B/escape` is materialized beneath `r/A/B -> ..` (i.e. at
    // `r/escape`), so its `../../outside` target escapes.
    let links = HashMap::from([
        ("r/A/B".to_owned(), "..".to_owned()),
        ("r/A/B/escape".to_owned(), "../../outside".to_owned()),
    ]);
    cowork_env::archive::validate_symlink_graph_with_case_folding(&links, false)
        .expect_err("nested link must be resolved from its physical parent");
}

fn write_tar_zst_with_symlink(path: &Path, link: &str, target: &str) {
    let file = std::fs::File::create(path).unwrap();
    let encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(0);
    header.set_mode(0o777);
    header.set_entry_type(tar::EntryType::Symlink);
    builder
        .append_link(&mut header, link, target)
        .expect("append symlink");
    builder.into_inner().unwrap().finish().unwrap();
}

#[test]
fn dangling_symlink_to_an_external_target_is_rejected() {
    let (_tmp, root) = tempdir("cowork-dangling-escape-");
    let dest = root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    // A pre-existing dangling link inside the destination points at a not-yet-existing
    // location outside it; the archive link `a -> b` chains through it.
    std::os::unix::fs::symlink("../outside-not-yet-created", dest.join("b")).unwrap();
    let archive = root.join("pack.tar.zst");
    write_tar_zst_with_symlink(&archive, "a", "b");

    let err = extract_v2_tar_zst_archive(&archive, &dest)
        .expect_err("a dangling link that resolves outside the root must be rejected");
    assert!(err.to_string().contains("escapes"), "{err}");
    assert!(!root.join("outside-not-yet-created").exists());
}

// ---------------------------------------------------------------------------------------------
// Manifest paths must stay inside the runtime root (comment 4460515759, part 1)
// ---------------------------------------------------------------------------------------------

fn manifest_paths(node: &str) -> RuntimeManifestPaths {
    serde_json::from_value(serde_json::json!({
        "bin": "dependencies/bin",
        "node": node,
        "python": "dependencies/python/bin/python3",
        "nodeModules": "node_modules",
        "nodeResolver": "cowork/node-resolver/register.mjs",
    }))
    .unwrap()
}

#[test]
fn manifest_paths_reject_absolute_traversal_and_escaping_entries() {
    let (_tmp, root) = tempdir("cowork-manifest-paths-");
    populate_staging(&root);

    let ok =
        RuntimePaths::from_manifest_paths(&root, &manifest_paths("dependencies/node/bin/node"))
            .expect("safe relative paths resolve");
    assert_eq!(ok.node, root.join("dependencies/node/bin/node"));

    for bad in [
        "/usr/bin/node",
        "../outside/node",
        "dependencies/../../node",
        "C:/node.exe",
        "dependencies\\node",
    ] {
        let paths = manifest_paths(bad);
        assert!(paths.validate().is_err(), "validate() must reject {bad:?}");
        assert!(
            RuntimePaths::from_manifest_paths(&root, &paths).is_err(),
            "from_manifest_paths must reject {bad:?}"
        );
    }

    // A relative entry that resolves outside the root through a symlink is rejected too.
    let outside = root.parent().unwrap().join(format!(
        "{}-outside",
        root.file_name().unwrap().to_string_lossy()
    ));
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    let err = RuntimePaths::from_manifest_paths(&root, &manifest_paths("escape/node"))
        .expect_err("symlinked escape must be rejected");
    assert!(err.to_string().contains("escapes"), "{err}");
    std::fs::remove_dir_all(&outside).unwrap();
}

// ---------------------------------------------------------------------------------------------
// v2 trusted symlinks come from signed pack metadata (comment 4460515759, part 2)
// ---------------------------------------------------------------------------------------------

struct V2Install {
    _tmp: tempfile::TempDir,
    runtime: PreparedRuntime,
    key_id: String,
    signing_key: SigningKey,
    trusted_keys: TrustedKeyRing,
}

fn install_v2_with_symlink(prefix: &str) -> V2Install {
    let (tmp, root) = tempdir(prefix);
    let staging = root.join("staging");
    populate_staging(&staging);
    std::os::unix::fs::symlink("node", staging.join("dependencies/node/bin/node-alias")).unwrap();
    let asset = resolve_host_asset().unwrap();
    let (key_id, signing_key, trusted_keys) = test_keypair();
    let core = root.join("cowork-runtime-core.tar.zst");
    let py = root.join("cowork-runtime-python-wheels.tar.zst");
    for (pack_id, out) in [
        (RuntimePackId::Core, &core),
        (RuntimePackId::PythonWheels, &py),
    ] {
        build_signed_v2_pack_tar_zst_fixture(
            &staging,
            pack_id,
            V2_VERSION,
            &asset,
            &key_id,
            &signing_key,
            out,
        )
        .unwrap();
    }
    let runtime = install_v2_pack_set(
        &[
            (RuntimePackId::Core, core.as_path()),
            (RuntimePackId::PythonWheels, py.as_path()),
        ],
        &RuntimeInstallOptions {
            homedir: root.join("home"),
            trusted_keys: trusted_keys.clone(),
            expected_version: Some(V2_VERSION.to_owned()),
            expected_archive_sha256: None,
            force: false,
            keep_versions: 2,
            on_progress: None,
        },
    )
    .expect("install v2 pack set");
    unseal_tree_for_removal(&runtime.root_dir).unwrap();
    V2Install {
        _tmp: tmp,
        runtime,
        key_id,
        signing_key,
        trusted_keys,
    }
}

fn replace_file(path: &Path, bytes: &[u8]) {
    let _ = std::fs::remove_file(path);
    std::fs::write(path, bytes).unwrap();
}

fn edit_json(path: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    edit(&mut value);
    replace_file(path, &serde_json::to_vec_pretty(&value).unwrap());
}

impl V2Install {
    fn core_meta(&self, name: &str) -> PathBuf {
        self.runtime.root_dir.join(".packs/core").join(name)
    }

    /// Rewrites and re-signs the core pack's `pack-integrity.json` with the trusted test key.
    fn resign_core(&self, edit: impl FnOnce(&mut RuntimeIntegrityManifest)) {
        let int_path = self.core_meta("pack-integrity.json");
        let mut integrity: RuntimeIntegrityManifest =
            serde_json::from_slice(&std::fs::read(&int_path).unwrap()).unwrap();
        edit(&mut integrity);
        let bytes = serde_json::to_vec_pretty(&integrity).unwrap();
        let envelope = RuntimeSignatureEnvelope {
            schema_version: 1,
            algorithm: "Ed25519".to_owned(),
            key_id: self.key_id.clone(),
            signature: data_encoding::BASE64.encode(&self.signing_key.sign(&bytes).to_bytes()),
        };
        replace_file(&int_path, &bytes);
        replace_file(
            &self.core_meta("pack-integrity.sig"),
            &serde_json::to_vec_pretty(&envelope).unwrap(),
        );
    }

    fn verify(&self) -> cowork_env::Result<PreparedRuntime> {
        verify_installed_runtime(&self.runtime.root_dir, &self.trusted_keys, true)
    }
}

#[test]
fn unsigned_runtime_json_cannot_disable_the_signed_symlink_allowlist() {
    let fx = install_v2_with_symlink("cowork-v2-trusted-symlinks-");
    fx.verify().expect("pristine install verifies");

    // Signed pack.json narrows the allowlist so it no longer covers the shipped symlink.
    let pack_json = fx.core_meta("pack.json");
    edit_json(&pack_json, |v| {
        v["trustedSymlinks"] = serde_json::json!(["dependencies/node/bin/other"]);
    });
    let (sha, b3, size) = cowork_env::hash_regular_file(&pack_json).unwrap();
    fx.resign_core(|int| {
        let entry = int
            .files
            .iter_mut()
            .find(|f| f.path == "pack.json")
            .unwrap();
        entry.sha256 = Some(sha);
        entry.blake3 = Some(b3);
        entry.size = size;
    });
    // The unsigned, installer-synthesized runtime.json tries to disable the check entirely.
    edit_json(&fx.runtime.root_dir.join("runtime.json"), |v| {
        v["trustedSymlinks"] = serde_json::json!([]);
    });

    let err = fx
        .verify()
        .expect_err("the signed allowlist must still reject the untrusted symlink");
    assert!(err.to_string().contains("Untrusted symlink"), "{err}");
}

#[test]
fn pack_integrity_must_sign_pack_json_and_match_the_envelope() {
    let fx = install_v2_with_symlink("cowork-v2-pack-json-unsigned-");
    fx.resign_core(|int| int.files.retain(|f| f.path != "pack.json"));
    let err = fx
        .verify()
        .expect_err("unsigned pack.json must be rejected");
    assert!(err.to_string().contains("does not sign pack.json"), "{err}");

    let fx = install_v2_with_symlink("cowork-v2-pack-keyid-");
    fx.resign_core(|int| int.key_id = "some-other-key".to_owned());
    let err = fx.verify().expect_err("keyId mismatch must be rejected");
    assert!(err.to_string().contains("keyId"), "{err}");

    let fx = install_v2_with_symlink("cowork-v2-pack-schema-");
    fx.resign_core(|int| int.schema_version = 3);
    let err = fx
        .verify()
        .expect_err("unknown pack integrity schema must be rejected");
    assert!(err.to_string().contains("schemaVersion"), "{err}");
}
