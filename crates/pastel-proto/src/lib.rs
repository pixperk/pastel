//! pastel wire protocol.
//!
//! Stable across versions until v1.0. Encoded with `postcard`.

use serde::{Deserialize, Serialize};

pub type Seq = u64;
pub type PlayerId = u32;
pub type RoomCode = [u8; 6];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Point {
    pub dx: i8,
    pub dy: i8,
    pub dt: u8,
    pub pressure: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Player {
    pub id: PlayerId,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompletedStroke {
    pub player: PlayerId,
    pub stroke_id: u32,
    pub origin: (u16, u16),
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoomSnapshot {
    pub players: Vec<Player>,
    pub completed: Vec<CompletedStroke>,
    pub seq: Seq,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameAction {
    Start,
    PickWord(u8),
    Kick(PlayerId),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameEvent {
    RoundStart { drawer: PlayerId, word_mask: String, duration_ms: u32 },
    RoundEnd { word: String, scores: Vec<(PlayerId, u32)> },
    GameOver { final_scores: Vec<(PlayerId, u32)> },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GuessKind {
    Correct,
    Close,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ByeReason {
    Reconnect,
    Kicked,
    RoomClosed,
    RoomFull,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub room: RoomCode,
    pub name: String,
    pub resume_from: Option<Seq>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ClientMsg {
    Hello(Hello),
    Stroke { stroke_id: u32, origin: (u16, u16), points: Vec<Point>, finished: bool },
    Chat { text: String },
    Guess { text: String },
    Game(GameAction),
    Pong { nonce: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ServerMsg {
    Welcome { you: PlayerId, snapshot: RoomSnapshot, seq: Seq, lk_token: String },
    Resume { events: Vec<ServerMsg> },
    Stroke { seq: Seq, player: PlayerId, stroke_id: u32, origin: (u16, u16), points: Vec<Point>, finished: bool },
    Chat { seq: Seq, player: PlayerId, text: String },
    Guess { seq: Seq, player: PlayerId, kind: GuessKind },
    Presence { seq: Seq, joined: Vec<Player>, left: Vec<PlayerId> },
    Game { seq: Seq, event: GameEvent },
    Ping { nonce: u32 },
    Bye { reason: ByeReason },
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("postcard: {0}")]
    Postcard(#[from] postcard::Error),
}

pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, CodecError> {
    Ok(postcard::to_allocvec(msg)?)
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, CodecError> {
    Ok(postcard::from_bytes(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_stroke() {
        let msg = ClientMsg::Stroke {
            stroke_id: 7,
            origin: (320, 240),
            points: vec![Point { dx: 1, dy: -2, dt: 16, pressure: 200 }; 30],
            finished: false,
        };
        let bytes = encode(&msg).unwrap();
        let back: ClientMsg = decode(&bytes).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn stroke_size_budget() {
        let msg = ClientMsg::Stroke {
            stroke_id: 7,
            origin: (320, 240),
            points: vec![Point { dx: 1, dy: -2, dt: 16, pressure: 200 }; 30],
            finished: false,
        };
        let bytes = encode(&msg).unwrap();
        assert!(bytes.len() <= 140, "stroke batch was {} bytes", bytes.len());
    }
}
