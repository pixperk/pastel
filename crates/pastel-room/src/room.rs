use crate::bucket::TokenBucket;
use crate::{
    BROADCAST_CAPACITY, CHAT_RING, COMMAND_INBOX_CAPACITY, COMPLETED_STROKES_RING, UNICAST_CAPACITY,
};
use ahash::AHashMap;
use pastel_proto::*;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot};

const CHAT_BUCKET_CAPACITY: f32 = 5.0;
const CHAT_REFILL_PER_SEC: f32 = 5.0 / 3.0;
const GUESS_BUCKET_CAPACITY: f32 = 10.0;
const GUESS_REFILL_PER_SEC: f32 = 10.0 / 3.0;

pub enum RoomCmd {
    Join {
        hello: Hello,
        reply: oneshot::Sender<Result<JoinResult, JoinError>>,
    },
    Leave {
        player: PlayerId,
    },
    FromClient {
        player: PlayerId,
        msg: ClientMsg,
    },
    SetSecret {
        drawer: PlayerId,
        word: String,
    },
}

pub struct JoinResult {
    pub you: PlayerId,
    pub unicast_rx: mpsc::Receiver<Arc<ServerMsg>>,
    pub broadcast_rx: broadcast::Receiver<Arc<ServerMsg>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JoinError {
    #[error("room is full")]
    RoomFull,
    #[error("room is closed")]
    RoomClosed,
}

#[derive(Clone)]
pub struct RoomHandle {
    cmd_tx: mpsc::Sender<RoomCmd>,
}

impl RoomHandle {
    pub async fn join(&self, hello: Hello) -> Result<JoinResult, JoinError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(RoomCmd::Join { hello, reply: tx })
            .await
            .map_err(|_| JoinError::RoomClosed)?;
        rx.await.map_err(|_| JoinError::RoomClosed)?
    }

    pub async fn send(&self, player: PlayerId, msg: ClientMsg) {
        let _ = self.cmd_tx.send(RoomCmd::FromClient { player, msg }).await;
    }

    pub async fn leave(&self, player: PlayerId) {
        let _ = self.cmd_tx.send(RoomCmd::Leave { player }).await;
    }

    pub async fn set_secret(&self, drawer: PlayerId, word: impl Into<String>) {
        let _ = self
            .cmd_tx
            .send(RoomCmd::SetSecret {
                drawer,
                word: word.into(),
            })
            .await;
    }
}

pub fn spawn_room(code: RoomCode) -> RoomHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_INBOX_CAPACITY);
    let (bc_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let room = Room::new(code, bc_tx);
    tokio::spawn(room.run(cmd_rx));
    RoomHandle { cmd_tx }
}

struct PlayerSlot {
    name: String,
    #[allow(dead_code)]
    unicast_tx: mpsc::Sender<Arc<ServerMsg>>,
    chat_bucket: TokenBucket,
    guess_bucket: TokenBucket,
}

#[derive(Default)]
struct InProgressStroke {
    origin: (u16, u16),
    points: Vec<Point>,
}

#[derive(Default)]
struct GameState {
    drawer: Option<PlayerId>,
    secret: Option<String>,
}

struct Room {
    #[allow(dead_code)]
    code: RoomCode,
    seq: Seq,
    next_player_id: PlayerId,
    players: AHashMap<PlayerId, PlayerSlot>,
    completed: VecDeque<CompletedStroke>,
    in_progress: AHashMap<(PlayerId, u32), InProgressStroke>,
    chat: VecDeque<(Seq, PlayerId, String)>,
    game: GameState,
    broadcast_tx: broadcast::Sender<Arc<ServerMsg>>,
}

impl Room {
    fn new(code: RoomCode, broadcast_tx: broadcast::Sender<Arc<ServerMsg>>) -> Self {
        Self {
            code,
            seq: 0,
            next_player_id: 1,
            players: AHashMap::new(),
            completed: VecDeque::with_capacity(COMPLETED_STROKES_RING),
            in_progress: AHashMap::new(),
            chat: VecDeque::with_capacity(CHAT_RING),
            game: GameState::default(),
            broadcast_tx,
        }
    }

    async fn run(mut self, mut inbox: mpsc::Receiver<RoomCmd>) {
        while let Some(cmd) = inbox.recv().await {
            match cmd {
                RoomCmd::Join { hello, reply } => self.handle_join(hello, reply),
                RoomCmd::Leave { player } => self.handle_leave(player),
                RoomCmd::FromClient { player, msg } => self.handle_client_msg(player, msg),
                RoomCmd::SetSecret { drawer, word } => self.handle_set_secret(drawer, word),
            }
        }
    }

    fn next_seq(&mut self) -> Seq {
        self.seq += 1;
        self.seq
    }

    fn broadcast(&self, msg: ServerMsg) {
        let _ = self.broadcast_tx.send(Arc::new(msg));
    }

    #[allow(dead_code)]
    fn unicast(&self, player: PlayerId, msg: ServerMsg) {
        if let Some(slot) = self.players.get(&player) {
            let _ = slot.unicast_tx.try_send(Arc::new(msg));
        }
    }

    fn snapshot(&self) -> RoomSnapshot {
        RoomSnapshot {
            players: self
                .players
                .iter()
                .map(|(id, slot)| Player {
                    id: *id,
                    name: slot.name.clone(),
                })
                .collect(),
            completed: self.completed.iter().cloned().collect(),
            seq: self.seq,
        }
    }

    fn handle_join(&mut self, hello: Hello, reply: oneshot::Sender<Result<JoinResult, JoinError>>) {
        if self.players.len() >= MAX_PLAYERS_PER_ROOM {
            let _ = reply.send(Err(JoinError::RoomFull));
            return;
        }

        let id = self.next_player_id;
        self.next_player_id = self.next_player_id.wrapping_add(1);

        let (uc_tx, uc_rx) = mpsc::channel(UNICAST_CAPACITY);
        let bc_rx = self.broadcast_tx.subscribe();

        let welcome = ServerMsg::Welcome {
            you: id,
            snapshot: self.snapshot(),
            seq: self.seq,
            lk_token: String::new(),
        };
        let _ = uc_tx.try_send(Arc::new(welcome));

        self.players.insert(
            id,
            PlayerSlot {
                name: hello.name.clone(),
                unicast_tx: uc_tx,
                chat_bucket: TokenBucket::new(CHAT_BUCKET_CAPACITY, CHAT_REFILL_PER_SEC),
                guess_bucket: TokenBucket::new(GUESS_BUCKET_CAPACITY, GUESS_REFILL_PER_SEC),
            },
        );

        let _ = reply.send(Ok(JoinResult {
            you: id,
            unicast_rx: uc_rx,
            broadcast_rx: bc_rx,
        }));

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Presence {
            seq,
            joined: vec![Player {
                id,
                name: hello.name,
            }],
            left: vec![],
        });
    }

    fn handle_leave(&mut self, player: PlayerId) {
        if self.players.remove(&player).is_none() {
            return;
        }
        self.in_progress.retain(|(p, _), _| *p != player);
        if self.game.drawer == Some(player) {
            self.game = GameState::default();
        }
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Presence {
            seq,
            joined: vec![],
            left: vec![player],
        });
    }

    fn handle_set_secret(&mut self, drawer: PlayerId, word: String) {
        self.game = GameState {
            drawer: Some(drawer),
            secret: Some(word),
        };
    }

    fn handle_client_msg(&mut self, player: PlayerId, msg: ClientMsg) {
        if !self.players.contains_key(&player) {
            return;
        }
        match msg {
            ClientMsg::Stroke {
                stroke_id,
                origin,
                points,
                finished,
            } => self.handle_stroke(player, stroke_id, origin, points, finished),
            ClientMsg::Chat { text } => self.handle_chat(player, text),
            ClientMsg::Guess { text } => self.handle_guess(player, text),
            ClientMsg::Hello(_) | ClientMsg::Game(_) | ClientMsg::Pong { .. } => {
                // Hello is for connection setup, handled via RoomCmd::Join.
                // Game actions and Pong land here in later phases.
            }
        }
    }

    fn handle_stroke(
        &mut self,
        player: PlayerId,
        stroke_id: u32,
        origin: (u16, u16),
        points: Vec<Point>,
        finished: bool,
    ) {
        let key = (player, stroke_id);
        let entry = self
            .in_progress
            .entry(key)
            .or_insert_with(|| InProgressStroke {
                origin,
                points: Vec::new(),
            });
        entry.points.extend_from_slice(&points);

        if finished {
            if let Some(done) = self.in_progress.remove(&key) {
                self.completed.push_back(CompletedStroke {
                    player,
                    stroke_id,
                    origin: done.origin,
                    points: done.points,
                });
                while self.completed.len() > COMPLETED_STROKES_RING {
                    self.completed.pop_front();
                }
            }
        }

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Stroke {
            seq,
            player,
            stroke_id,
            origin,
            points,
            finished,
        });
    }

    fn handle_chat(&mut self, player: PlayerId, text: String) {
        let Some(slot) = self.players.get_mut(&player) else {
            return;
        };
        if !slot.chat_bucket.try_take() {
            return;
        }
        let seq = self.next_seq();
        self.chat.push_back((seq, player, text.clone()));
        while self.chat.len() > CHAT_RING {
            self.chat.pop_front();
        }
        self.broadcast(ServerMsg::Chat { seq, player, text });
    }

    fn handle_guess(&mut self, player: PlayerId, text: String) {
        let Some(slot) = self.players.get_mut(&player) else {
            return;
        };
        if !slot.guess_bucket.try_take() {
            return;
        }

        if self.game.drawer == Some(player) {
            return;
        }

        let is_correct = match &self.game.secret {
            Some(word) => text.trim().eq_ignore_ascii_case(word.trim()),
            None => false,
        };

        if is_correct {
            let seq = self.next_seq();
            self.broadcast(ServerMsg::Guess {
                seq,
                player,
                kind: GuessKind::Correct,
            });
        } else {
            let seq = self.next_seq();
            self.broadcast(ServerMsg::Chat { seq, player, text });
        }
    }
}
