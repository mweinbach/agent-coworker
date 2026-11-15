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
}
