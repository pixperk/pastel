//! Per-room actor task.
//!
//! One [`Room`] owns its state; mutation happens only inside its task loop.
//! Connection tasks talk to it via [`RoomCmd`] over an `mpsc` inbox and
//! receive [`ServerMsg`]s via a `broadcast` channel (room-wide) plus a
//! per-player `mpsc` (unicast for things like correct-guess feedback).

#![allow(dead_code)]

use pastel_proto::*;
use std::sync::Arc;

pub const BROADCAST_CAPACITY: usize = 1024;
pub const MAX_PLAYERS_PER_ROOM: usize = 10;
pub const COMPLETED_STROKES_RING: usize = 256;
pub const CHAT_RING: usize = 50;

pub enum RoomCmd {
    Join {
        hello: Hello,
        reply: tokio::sync::oneshot::Sender<JoinResult>,
    },
    Leave {
        player: PlayerId,
    },
    FromClient {
        player: PlayerId,
        msg: ClientMsg,
    },
}

pub struct JoinResult {
    pub you: PlayerId,
    pub snapshot: RoomSnapshot,
    pub seq: Seq,
    pub unicast_rx: tokio::sync::mpsc::Receiver<Arc<ServerMsg>>,
    pub broadcast_rx: tokio::sync::broadcast::Receiver<Arc<ServerMsg>>,
}
