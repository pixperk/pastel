use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use pastel_proto::{
    decode_client_validated, encode, ByeReason, ClientMsg, Hello, RoomCode, ServerMsg,
};
use pastel_room::{JoinError, RoomHandle};
use tokio::sync::broadcast::error::RecvError as BroadcastRecvError;

pub async fn ws_handler(
    State(state): State<AppState>,
    Path(code): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let room_code = match RoomCode::parse(&code) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("invalid room code: {e}")).into_response();
        }
    };
    let handle = state.rooms.get_or_create(room_code);
    ws.on_upgrade(move |socket| connection_task(socket, handle))
}

async fn connection_task(mut socket: WebSocket, room: RoomHandle) {
    let hello = match recv_hello(&mut socket).await {
        Ok(h) => h,
        Err(err) => {
            tracing::debug!(%err, "hello handshake failed");
            let _ = send_bye(&mut socket, ByeReason::BadFrame).await;
            return;
        }
    };

    let join = match room.join(hello).await {
        Ok(j) => j,
        Err(JoinError::RoomFull) => {
            let _ = send_bye(&mut socket, ByeReason::RoomFull).await;
            return;
        }
        Err(JoinError::RoomClosed) => {
            let _ = send_bye(&mut socket, ByeReason::RoomClosed).await;
            return;
        }
    };

    let pastel_room::JoinResult {
        you,
        mut unicast_rx,
        mut broadcast_rx,
    } = join;

    loop {
        tokio::select! {
            biased;

            uc = unicast_rx.recv() => match uc {
                Some(msg) => {
                    if let Err(err) = send_msg(&mut socket, &msg).await {
                        tracing::debug!(%err, "unicast send failed");
                        break;
                    }
                }
                None => break,
            },

            bc = broadcast_rx.recv() => match bc {
                Ok(msg) => {
                    if let Err(err) = send_msg(&mut socket, &msg).await {
                        tracing::debug!(%err, "broadcast send failed");
                        break;
                    }
                }
                Err(BroadcastRecvError::Lagged(n)) => {
                    tracing::debug!(skipped = n, "client lagged broadcast, closing");
                    let _ = send_bye(&mut socket, ByeReason::Reconnect).await;
                    break;
                }
                Err(BroadcastRecvError::Closed) => break,
            },

            ws_msg = socket.recv() => match ws_msg {
                Some(Ok(Message::Binary(bytes))) => match decode_client_validated(&bytes) {
                    Ok(msg) => room.send(you, msg).await,
                    Err(err) => {
                        tracing::debug!(%err, "client frame rejected");
                        let _ = send_bye(&mut socket, ByeReason::BadFrame).await;
                        break;
                    }
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(err)) => {
                    tracing::debug!(%err, "ws recv error");
                    break;
                }
                Some(Ok(_)) => {
                    // ignore text / ping / pong — axum auto-pongs.
                }
            },
        }
    }

    room.leave(you).await;
}

async fn recv_hello(socket: &mut WebSocket) -> anyhow::Result<Hello> {
    let frame = match socket.recv().await {
        Some(Ok(m)) => m,
        Some(Err(e)) => anyhow::bail!("ws error before hello: {e}"),
        None => anyhow::bail!("socket closed before hello"),
    };
    let bytes = match frame {
        Message::Binary(b) => b,
        other => anyhow::bail!("expected binary hello, got {other:?}"),
    };
    match decode_client_validated(&bytes)? {
        ClientMsg::Hello(h) => Ok(h),
        other => anyhow::bail!("expected Hello, got {other:?}"),
    }
}

async fn send_msg(socket: &mut WebSocket, msg: &ServerMsg) -> anyhow::Result<()> {
    let bytes = encode(msg)?;
    socket.send(Message::Binary(bytes)).await?;
    Ok(())
}

async fn send_bye(socket: &mut WebSocket, reason: ByeReason) -> anyhow::Result<()> {
    send_msg(socket, &ServerMsg::Bye { reason }).await
}
