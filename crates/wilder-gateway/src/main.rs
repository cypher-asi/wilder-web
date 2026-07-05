//! Wilder gateway: HTTP (auth, characters, assets) + WebSocket (game) entry.

mod http;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::http::header::{HeaderValue, CONTENT_TYPE};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use wilder_auth::AuthService;
use wilder_persistence::RocksStore;
use wilder_world::WorldHandle;

pub struct AppState {
    pub store: Arc<RocksStore>,
    pub auth: AuthService<RocksStore>,
    pub world: WorldHandle,
    pub dev_mode: bool,
}

pub type SharedState = Arc<AppState>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    wilder_telemetry::init("info,wilder=debug");

    let data_dir = std::env::var("WILDER_DATA").unwrap_or_else(|_| "data/world".into());
    let dev_mode = std::env::var("WILDER_DEV").map(|v| v == "1").unwrap_or(false);
    let port: u16 = std::env::var("WILDER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    std::fs::create_dir_all(&data_dir)?;
    let store = Arc::new(RocksStore::open(&data_dir)?);
    let world = wilder_world::spawn_world(store.clone());
    let auth = AuthService::new(store.clone());

    let state: SharedState = Arc::new(AppState { store, auth, world, dev_mode });

    let mut app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/register", post(http::register))
        .route("/api/login", post(http::login))
        .route("/api/characters", get(http::list_characters).post(http::create_character))
        .route("/ws", get(ws::ws_handler));

    if dev_mode {
        app = app.route("/dev/login", post(http::dev_login));
        tracing::warn!("dev mode: /dev/login is enabled");
    }

    // Static game assets (models, textures, audio, manifest).
    let assets_dir = std::env::var("WILDER_ASSETS").unwrap_or_else(|_| "assets".into());
    let mut app = app.nest_service("/assets", ServeDir::new(assets_dir));

    // In production, serve the built web client (SPA) from the same origin so
    // the client's relative /ws, /api and /assets URLs resolve without CORS or
    // a separate proxy. Unmatched routes fall back to index.html for the SPA.
    // Skipped in local dev, where Vite serves the client and proxies to us.
    let web_dist = std::env::var("WILDER_WEB_DIST").unwrap_or_else(|_| "apps/web/dist".into());
    if std::path::Path::new(&web_dist).is_dir() {
        let index = format!("{web_dist}/index.html");
        app = app
            .fallback_service(ServeDir::new(&web_dist).not_found_service(ServeFile::new(index)));
        tracing::info!("serving web client from {web_dist}");
    }

    let app = app
        .layer(axum::middleware::map_response(utf8_charset))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("gateway listening on http://localhost:{port}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Stamp `charset=utf-8` onto text-ish responses. tower-http's `ServeDir`
/// emits bare `text/html` / `text/javascript` content types; without an
/// explicit charset, proxies and capture tools (and any browser that misses
/// the meta tag) fall back to Latin-1 and mangle the client's UTF-8 glyphs
/// (em dashes and item icons) into mojibake.
async fn utf8_charset(mut response: Response) -> Response {
    let amended = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|ct| !ct.contains("charset"))
        .filter(|ct| {
            ct.starts_with("text/")
                || *ct == "application/javascript"
                || *ct == "application/json"
                || *ct == "image/svg+xml"
        })
        .and_then(|ct| HeaderValue::from_str(&format!("{ct}; charset=utf-8")).ok());
    if let Some(value) = amended {
        response.headers_mut().insert(CONTENT_TYPE, value);
    }
    response
}
