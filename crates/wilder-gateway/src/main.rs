//! Wilder gateway: HTTP (auth, characters, assets) + WebSocket (game) entry.

mod http;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
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
    let app = app
        .nest_service("/assets", ServeDir::new(assets_dir))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("gateway listening on http://localhost:{port}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
