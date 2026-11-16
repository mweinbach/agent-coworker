use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    for var in [
        "COWORK_APP_VERSION",
        "COWORK_UPDATER_PUBKEY",
        "CARGO_PACKAGER_SIGN_PUBLIC_KEY",
        "COWORK_UPDATER_FEED_URL",
        "COWORK_SENTRY_DSN",
        "COWORK_SENTRY_ENVIRONMENT",
        "SENTRY_ENVIRONMENT",
        "COWORK_POSTHOG_KEY",
        "COWORK_POSTHOG_HOST",
        "COWORK_POSTHOG_ENVIRONMENT",
        "COWORK_PRODUCT_ANALYTICS_ENV",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        embed_macos_info_plist();
    }
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

fn embed_macos_info_plist() {
    let version = env::var("COWORK_APP_VERSION")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| env::var("CARGO_PKG_VERSION").ok())
        .unwrap_or_else(|| "0.0.0".to_string());
    let escaped_version = xml_escape(&version);

    let plist = format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "  <key>CFBundleIdentifier</key>\n",
            "  <string>com.cowork.desktop</string>\n",
            "  <key>CFBundleName</key>\n",
            "  <string>Cowork</string>\n",
            "  <key>CFBundleDisplayName</key>\n",
            "  <string>Cowork</string>\n",
            "  <key>CFBundleShortVersionString</key>\n",
            "  <string>{ver}</string>\n",
            "  <key>CFBundleVersion</key>\n",
            "  <string>{ver}</string>\n",
            "</dict>\n",
            "</plist>\n"
        ),
        ver = escaped_version
    );

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set by Cargo"));
    let plist_path = out_dir.join("Info.plist");
    if fs::read(&plist_path).ok().as_deref() != Some(plist.as_bytes()) {
        fs::write(&plist_path, plist.as_bytes()).expect("failed to write macOS Info.plist");
    }

    let plist_arg = plist_path
        .to_str()
        .expect("OUT_DIR Info.plist path must be valid UTF-8");
    for arg in [
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        plist_arg,
    ] {
        println!("cargo:rustc-link-arg-bin=cowork-desktop={arg}");
    }
}
