//! pastel-server library: HTTP + WebSocket entrypoint and room registry.
//!
//! The binary in `src/main.rs` is a thin wrapper that builds the router and
//! serves it on a TCP listener. Integration tests use the same `build_router`
//! against a port-zero listener.

pub mod rooms;
pub mod ws;

use axum::extract::State;
use axum::routing::get;
use axum::Router;

#[derive(Clone)]
pub struct AppState {
    pub rooms: rooms::Rooms,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rooms: rooms::Rooms::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/ws/:code", get(ws::ws_handler))
        .with_state(state)
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
