//! Logging/metrics bootstrap shared by server binaries.

use tracing_subscriber::EnvFilter;

/// Install a global tracing subscriber. `RUST_LOG` overrides the default filter.
pub fn init(default_filter: &str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_filter));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .compact()
        .init();
}
