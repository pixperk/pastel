use dashmap::DashMap;
use pastel_proto::RoomCode;
use pastel_room::{spawn_room_with_evictor, RoomHandle, WordLists};
use std::sync::Arc;

#[derive(Clone)]
pub struct Rooms {
    inner: Arc<DashMap<RoomCode, RoomHandle>>,
    words: Arc<WordLists>,
}

impl Rooms {
    pub fn new(words: Arc<WordLists>) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            words,
        }
    }

    pub fn get_or_create(&self, code: RoomCode) -> RoomHandle {
        let words = self.words.clone();
        let map = self.inner.clone();
        self.inner
            .entry(code)
            .or_insert_with(|| {
                spawn_room_with_evictor(code, words, move || {
                    // Room signalled shutdown (lobby timeout or last human
                    // left). Drop the entry so the code is free for reuse.
                    map.remove(&code);
                })
            })
            .clone()
    }

    pub fn count(&self) -> usize {
        self.inner.len()
    }
}
