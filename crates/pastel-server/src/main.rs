use pastel_server::{build_router, AppState};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,pastel=debug".into()),
        )
        .init();

    let app = build_router(AppState::new());

    let addr: SocketAddr = "0.0.0.0:7070".parse()?;
    tracing::info!(%addr, "pastel-server listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
