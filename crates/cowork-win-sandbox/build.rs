use std::env;
use std::path::PathBuf;

const SETUP_BIN: &str = "codex-windows-sandbox-setup";
const SETUP_MANIFEST: &str = "codex-windows-sandbox-setup.manifest";

fn main() -> Result<(), String> {
    println!("cargo:rerun-if-changed={SETUP_MANIFEST}");
    println!("cargo:rerun-if-env-changed=COWORK_SANDBOX_BUILD_NONCE");
    if let Ok(nonce) = env::var("COWORK_SANDBOX_BUILD_NONCE") {
        println!("cargo:rustc-env=COWORK_SANDBOX_BUILD_NONCE={nonce}");
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .ok_or_else(|| "CARGO_MANIFEST_DIR should be set".to_string())?;
    let manifest_path = PathBuf::from(manifest_dir).join(SETUP_MANIFEST);
    match (
        env::var("CARGO_CFG_TARGET_ENV").as_deref(),
        env::var("CARGO_CFG_TARGET_ABI").as_deref(),
    ) {
        (Ok("msvc"), _) => {
            println!("cargo:rustc-link-arg-bin={SETUP_BIN}=/MANIFEST:EMBED");
            println!(
                "cargo:rustc-link-arg-bin={SETUP_BIN}=/MANIFESTINPUT:{}",
                manifest_path.display()
            );
        }
        (Ok("gnu"), Ok("llvm")) => {
            println!("cargo:rustc-link-arg-bin={SETUP_BIN}=-Wl,-Xlink=/manifest:embed");
            println!(
                "cargo:rustc-link-arg-bin={SETUP_BIN}=-Wl,-Xlink=/manifestinput:{}",
                manifest_path.display()
            );
        }
        _ => {}
    }
    Ok(())
}
