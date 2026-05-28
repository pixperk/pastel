//! pastel-server library: HTTP + WebSocket entrypoint and room registry.
//!
//! The binary in `src/main.rs` is a thin wrapper that builds the router and
//! serves it on a TCP listener. Integration tests use the same `build_router`
//! against a port-zero listener.

pub mod bot;
pub mod rooms;
pub mod voice;
pub mod words;
pub mod ws;

use axum::extract::State;
use axum::routing::{get, post};
use axum::Router;
use pastel_room::WordLists;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub rooms: rooms::Rooms,
}

impl AppState {
    pub fn new(words: Arc<WordLists>) -> Self {
        Self {
            rooms: rooms::Rooms::new(words),
        }
    }

    pub fn with_test_words() -> Self {
        Self::new(Arc::new(WordLists::test_fixture()))
    }
}

pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/ws/:code", get(ws::ws_handler))
        .route("/bot/:code", post(bot::add_bot))
        .route("/voice/token", get(voice::token))
        .with_state(state);

    // In production, serve the frontend dist/ folder as a static fallback.
    // In dev, Vite serves the frontend and proxies API calls to us.
    let dist_dir = std::env::var("PASTEL_DIST_DIR").unwrap_or_else(|_| "frontend/dist".into());
    let dist_path = std::path::PathBuf::from(&dist_dir);
    if dist_path.join("index.html").exists() {
        tracing::info!(path = %dist_dir, "serving static frontend");
        api.fallback_service(tower_http::services::ServeDir::new(&dist_dir).fallback(
            tower_http::services::ServeFile::new(dist_path.join("index.html")),
        ))
    } else {
        api
    }
}

async fn healthz() -> &'static str {
    "ok"
}

async fn metrics(State(state): State<AppState>) -> String {
    format!(
        "# HELP pastel_rooms_active Active rooms hosted on this node.\n\
         # TYPE pastel_rooms_active gauge\n\
         pastel_rooms_active {}\n",
        state.rooms.count(),
    )
}
