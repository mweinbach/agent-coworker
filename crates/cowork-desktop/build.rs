fn main() {
    for var in [
        "COWORK_APP_VERSION",
        "COWORK_UPDATER_PUBKEY",
        "COWORK_SENTRY_DSN",
        "COWORK_POSTHOG_KEY",
        "COWORK_POSTHOG_HOST",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
}
