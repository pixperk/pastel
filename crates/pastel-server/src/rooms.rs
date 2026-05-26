use dashmap::DashMap;
use pastel_proto::RoomCode;
use pastel_room::{spawn_room, RoomHandle};
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct Rooms {
    inner: Arc<DashMap<RoomCode, RoomHandle>>,
}

impl Rooms {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_create(&self, code: RoomCode) -> RoomHandle {
        self.inner
            .entry(code)
            .or_insert_with(|| spawn_room(code))
            .clone()
    }

    pub fn count(&self) -> usize {
        self.inner.len()
    }
}
