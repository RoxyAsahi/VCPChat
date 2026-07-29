fn main() {
    // The Electron build script supplies the revision.  Declaring the env
    // dependency is essential: without it Cargo can reuse a stale release
    // binary whose ready frame reports an empty/old revision.
    println!("cargo:rerun-if-env-changed=VCP_AGENT_BUILD_REVISION");
    let revision =
        std::env::var("VCP_AGENT_BUILD_REVISION").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=VCP_AGENT_BUILD_REVISION={revision}");
}
