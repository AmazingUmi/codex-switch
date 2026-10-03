//! Shared outgoing HTTP client.
//!
//! Uses reqwest's system/environment proxy detection. Application settings do
//! not override the network environment.

use once_cell::sync::OnceCell;
use reqwest::Client;
use std::time::Duration;

static GLOBAL_CLIENT: OnceCell<Client> = OnceCell::new();

/// Initialize the shared client once during startup.
pub fn init() -> Result<(), String> {
    GLOBAL_CLIENT.get_or_try_init(build_client).map(|_| ())
}

/// Return a shared client, initializing it lazily for callers before startup.
pub fn get() -> Client {
    GLOBAL_CLIENT
        .get_or_try_init(build_client)
        .cloned()
        .unwrap_or_else(|error| {
            log::error!("[HttpClient] Failed to initialize shared client: {error}");
            Client::default()
        })
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(Duration::from_secs(60))
        // Preserve the shared client's explicit compression policy.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))
}
