# pastel, Design

A real-time, room-based collaborative drawing + guessing game. No accounts.
Strokes feel like ink. Rooms hold up to 10. The system targets 10k concurrent
users (~1000 active rooms) on commodity hardware.

This document is the source of truth for architectural decisions. It records
the choices made, the alternatives rejected, and the reasoning. Code should
match this; if it diverges, update this first.

---

## 1. Goals and non-goals

**Goals**

- Strokes that *feel* like real ink: low input latency, smooth curves, no jitter.
- Multi-node horizontal scalability to 10k concurrent users.
- Graceful failure: node death loses at most a couple of seconds of in-progress
  drawing, never completed strokes or game state.
- Voice + text chat in every room.
- Simple to operate: small number of moving parts, no Kubernetes.
- Boring, defensible technology choices.

**Non-goals (v1)**

- User accounts, friends, profiles.
- Persistent game history, replays, leaderboards.
- Mobile-native clients (web only; mobile browsers fine).
- Moderation tooling beyond host kick + per-socket rate limits.
- Cross-region deployment.

---

## 2. Hard constraints

- **10 players per room.** Enforced inside the room task; race-free because the
  room is single-writer.
- **Global room cap** at the directory level (configurable; ~1500 to leave
  headroom over the 1000 target).
- **No auth.** Users are identified by an opaque per-connection `PlayerId` and
  a chosen display name. Names are not unique.

---

## 3. Topology

```
            ┌────────────┐
   client ─►│  Gateway   │  HTTP, stateless, N replicas behind any LB
            │  /rooms    │  → returns {code, ws_url, lk_token}
            │  /join/:c  │
            └─────┬──────┘
                  │ resolves room → node via rendezvous hash (HRW)
                  ▼
            ┌─────────────────────────────┐         ┌─────────┐
   ws ────► │  Room Node (Rust)           │ ◄────►  │  Redis  │
            │  - owns its slice of rooms  │         │ AOF on  │
            │  - one tokio task per room  │         └─────────┘
            │  - heartbeats to Redis      │
            └──────────────┬──────────────┘
                           │
                           ▼
                    ┌────────────┐
                    │  LiveKit   │  independent dimension; carries voice only
                    └────────────┘
```

Four components, each with one job. The gateway is not in the WebSocket path;
clients connect directly to the assigned room node.

---

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Server lang | Rust (stable) | The room task model + Tokio is a strong fit; portfolio-relevant. |
| HTTP / WS | `axum` + `tokio-tungstenite` | Idiomatic, well-supported, low ceremony. |
| Wire format | `postcard` (binary, serde-based) | ~4× smaller than JSON, no schema file. |
| Coordination store | Redis (single instance, AOF enabled) | Covers node registry, pub/sub, snapshots, rate limits in one piece. |
| Voice | LiveKit (self-hosted SFU) | Mature, free, has Rust + JS SDKs. Writing our own SFU is a multi-month detour. |
| Client | TypeScript + 2D `<canvas>` | Drawing is bandwidth-bound, not GPU-bound. WebGL adds no value here. |
| Observability | Prometheus + Grafana | Standard, dashboards check into repo. |

### Rejected

- **Postgres.** Considered for snapshots + node registry. Redis with AOF gives
  the same durability guarantees this workload needs (rooms are ephemeral) with
  one less service. Revisit if/when we add persistent game history.
- **Postgres + Memcached split.** Splits one job across two stateful services.
  Defensible but more code; not justified at this scale.
- **Protobuf.** Marginal size win over `postcard`, plus a `.proto` build step.
  Skip.
- **Kubernetes.** Six processes do not need an orchestrator. Docker Compose for
  dev, systemd or Nomad in prod.
- **Microservices** (matchmaking / chat / presence as separate services). All
  three are properties of the room. Splitting them would be a red flag.
- **WebRTC mesh / data channels for strokes.** Mesh dies past 4 peers; data
  channels lose the server's authoritative ordering and word-hiding logic.
- **WebGL canvas.** No GPU bottleneck. 2D canvas with quadratic Béziers
  produces inky strokes in ~10 lines.

---

## 5. The stroke-travel problem

This is the heart of the product. Three concerns are routinely conflated and
must be solved separately.

### 5.1 Capture (drawer's machine)

- Listen to `pointermove` + `pointerrawupdate` for high-frequency samples.
- Render every raw sample on the drawer's *own* canvas immediately. Their pen
  feels instant locally because the network is never in their critical path.
- Coalesce points into ~16 ms (60 Hz) batches before transmitting. Each batch
  is one `ClientMsg::Stroke` frame.

### 5.2 Transit (server)

- The room task is a **dumb relay with memory**. It does not smooth, render, or
  interpret strokes. It validates, assigns a monotonic `Seq`, fans out.
- Per-room `tokio::sync::broadcast` channel. Each connection task subscribes
  and writes to its socket.
- **Slow consumers are dropped, never blocked.** This is the only rule that
  matters at scale.

### 5.3 Render (viewers)

- Smooth points into a curve using **quadratic Béziers through midpoints of
  consecutive samples**. This is the trick that makes strokes look like ink
  rather than polylines.
- Width modulated by recent velocity (faster = thinner), gives a "pen
  pressure" feel without a real pen.
- A small jitter buffer (~50 ms) per viewer to absorb network hiccups. Tunable;
  lower = more responsive, more stutter risk.

---

## 6. Wire protocol

One WebSocket per client. All message types multiplexed. `postcard`-encoded.

### 6.1 Messages

```rust
#[derive(Serialize, Deserialize)]
pub enum ClientMsg {
    Hello   { room: RoomCode, name: String, resume_from: Option<Seq> },
    Stroke  { stroke_id: u32, points: Vec<Point>, finished: bool },
    Chat    { text: String },
    Guess   { text: String },        // game mode; server hides from others
    Game    (GameAction),            // start, pick-word, kick, etc.
    Pong    { nonce: u32 },
}

#[derive(Serialize, Deserialize)]
pub enum ServerMsg {
    Welcome  { you: PlayerId, snapshot: RoomSnapshot, seq: Seq, lk_token: String },
    Resume   { events: Vec<ServerMsg> },     // delta replay on reconnect
    Stroke   { seq: Seq, player: PlayerId, stroke_id: u32, points: Vec<Point>, finished: bool },
    Chat     { seq: Seq, player: PlayerId, text: String },
    Guess    { seq: Seq, player: PlayerId, kind: GuessKind }, // Correct | Close
    Presence { seq: Seq, joined: Vec<Player>, left: Vec<PlayerId> },
    Game     { seq: Seq, event: GameEvent },
    Ping     { nonce: u32 },
    Bye      { reason: ByeReason },          // Reconnect | Kicked | RoomClosed
}

#[derive(Serialize, Deserialize, Copy, Clone)]
pub struct Point {
    pub dx: i8,         // delta from previous point in this stroke
    pub dy: i8,
    pub dt: u8,         // ms since previous point (saturating)
    pub pressure: u8,   // 0..=255; client-derived from velocity if no real pen
}

pub type Seq      = u64;
pub type PlayerId = u32;
pub type RoomCode = [u8; 6];   // 6-char base32, case-insensitive
```

### 6.2 Wire properties

- **Deltas inside a stroke**, not absolute coords. ~4 bytes/point vs ~12.
- **`stroke_id`** is client-assigned (drawer's local counter). Lets the drawer
  correct in flight without a round-trip.
- **`Seq`** is server-assigned, monotonic per room, never reused. The only
  number that matters for ordering and resume.
- **`finished` flag** on `Stroke` so the server knows when to roll the stroke
  into the completed-strokes ring.

### 6.3 Sizing

A 30-point stroke segment ≈ 120 bytes. A 10-person room with one active drawer
at 60 Hz ≈ 7 KB/s per viewer. 1000 rooms ≈ 70 MB/s aggregate, well within a
single node's egress at this scale.

---

## 7. Fanout inside a room task

```rust
struct Room {
    code: RoomCode,
    seq: Seq,
    players: HashMap<PlayerId, PlayerState>,
    completed: VecDeque<CompletedStroke>,   // ring; catch-up for late joiners
    in_progress: HashMap<PlayerId, InProgress>,
    chat: VecDeque<ChatLine>,               // ring; last ~50
    tx: broadcast::Sender<Arc<ServerMsg>>,  // broadcast channel, cap 1024
    unicast: HashMap<PlayerId, mpsc::Sender<Arc<ServerMsg>>>,
    inbox: mpsc::Receiver<RoomCmd>,         // from connection tasks
}

enum RoomCmd {
    Join       { player: Player, hello: Hello, reply: oneshot::Sender<JoinResult> },
    Leave      { player: PlayerId },
    FromClient { player: PlayerId, msg: ClientMsg },
}
```

- Single writer = no locks on the hot path.
- `broadcast` for true room-wide fanout (strokes, presence, public chat).
- `mpsc` per player for **unicast** (correct-guess feedback to the guesser,
  word reveal to the drawer). Connection tasks `select!` on both.
- Each connection task does only two things: read from socket → send a
  `RoomCmd::FromClient`; read from its subscriptions → write to socket.

### 7.1 Backpressure

- `broadcast` capacity = 1024. A subscriber that lags receives `Lagged(n)`.
- Lagged subscribers are closed with `ServerMsg::Bye { Reconnect }`. They
  reconnect and resume from snapshot. Reviewer-facing rationale: **dropping a
  slow client never costs more than a stroke; blocking the room writer costs
  every client.**

### 7.2 Server-side coalescing (deferred)

If two `Stroke` messages from the same drawer for the same `stroke_id` arrive
within ~10 ms, merge before broadcasting. Halves message count under load.
Add only when load testing demands it.

---

## 8. Sequence numbers and resume

- Every state-changing `ServerMsg` carries a `seq`.
- Client persists `last_seq_seen` in memory.
- On reconnect: `Hello { resume_from: Some(last_seq_seen) }`.
- Room task decides:
  - **Gap covered by the ring** → send `Resume { events }` with the missing
    tail. Client appends, no flicker.
  - **Gap too large or room migrated** → send full `Welcome { snapshot }`.
    Client clears canvas and replays.

Brief disconnects (wifi flap, tunnel) are silent to the user.

---

## 9. Game logic: the guess wrinkle

The server is the gatekeeper because clients don't know the secret word.

```
guess matches word:
    → unicast to guesser : Guess { Correct }
    → unicast to drawer  : Guess { Correct, player }
    → broadcast (others) : "<player> guessed correctly!"  (no text)

guess is close (edit distance 1):
    → unicast to guesser : Guess { Close }

guess is wrong:
    → broadcast as normal chat
```

This is the reason a single `broadcast::Sender` isn't enough; we also need
per-player unicast.

---

## 10. Routing: rendezvous hashing

Room → node is computed, not stored.

```
node = argmax over current node set of  hash(room_code, node_id)
```

- Every gateway and every node computes the same mapping from the same node
  list. No ring state, no central authority.
- Node list lives in Redis as `node:<id>` keys with 15 s TTL. Nodes heartbeat
  every 5 s.
- Gateways subscribe to `nodes:changed` pub/sub for instant remap, with a 1 s
  poll fallback for safety.
- When a node leaves or joins, only ~1/N of rooms remap (same property as
  consistent hashing rings, simpler math).

### Why HRW over a ring

A hash ring requires maintaining the ring structure, virtual nodes for
balance, and careful add/remove. HRW is one `argmax` over a small list. At
fewer than ~50 nodes it is the better default.

---

## 11. Failover and snapshots

### 11.1 Snapshot policy

- During an active round: snapshot the room to Redis every 5 s.
  `SET room:<code>:snap <postcard-blob> EX 600`.
- On every round boundary: snapshot immediately. Redis AOF persists to disk.
- Snapshot contents: completed strokes (ring), game phase, player list (minus
  sockets), last `seq`, chat ring. ~5–50 KB compressed.

### 11.2 Node death

- Node dies → its `node:<id>` key expires within 15 s.
- HRW now maps that node's rooms to a different live node.
- Clients lose WS, reconnect, gateway resolves them to the new node.
- New node loads `room:<code>:snap` and rehydrates the room.
- Total downtime per room: ~1–3 s. Lost data: in-progress stroke segments from
  the last ≤5 s.

### 11.3 Graceful shutdown

- Node receives `SIGTERM`.
- Refuses new rooms.
- Forces snapshot of every owned room.
- Sends `Bye { Reconnect }` to every connection.
- Exits.

### 11.4 What can be lost vs what cannot

| Data | Loss budget on node death |
|---|---|
| In-progress stroke (last ≤5 s) | Acceptable loss |
| Completed strokes this round | Must survive |
| Game phase, current word, scores | Must survive |
| Chat older than 5 s | Acceptable loss |
| Voice | LiveKit handles independently; no impact |

---

## 12. Voice (LiveKit)

- Voice rides a separate transport. **Do not** push audio through the room WS.
- When a room is created, the room node also creates a matching LiveKit room
  via the LiveKit server SDK and mints a JWT for the joining client.
- Client uses the LiveKit JS SDK for audio; the room WS carries everything
  else.
- Presence source of truth = the room task. On WS disconnect, the room task
  evicts the player from LiveKit too. This prevents "ghost in voice but gone
  from game" states.

### Defaults

- Open mic, per-user mute, host can flip a "drawer speaks only" toggle.
- Opus codec, ~32–40 kbps target.
- Echo cancellation / noise suppression handled by browser + LiveKit defaults.

---

## 13. Capacity planning

Target: 10 000 concurrent users = ~1000 active rooms.

### Per node (room server)

- ~200 rooms / node.
- ~2 000 WebSocket connections.
- Stroke fanout out-bandwidth: 200 rooms × ~20 KB/s active draw = ~4 MB/s.
- CPU: dominated by `postcard` encode + WS frame writes; well under 1 core
  utilized at this load.

### Deployment shape

- **5 room nodes + 1 headroom node = 6.** Small VMs (2 vCPU, 2 GB RAM each).
- **2 gateway replicas** behind any LB. Tiny.
- **1 Redis** (or 1 primary + 1 replica if HA matters).
- **LiveKit cluster** sized to ~500 Mbps peak egress at full load, this is
  the dominant infra cost. Sized independently.

### Bottleneck order (the only ones that actually bite at 10k)

1. Voice egress bandwidth (LiveKit).
2. Open file descriptors per node, raise `nofile` ulimit early.
3. Redis pub/sub fanout for node-list churn, non-issue under ~50 nodes.

CPU and memory are not bottlenecks at this scale.

---

## 14. Rate limits and abuse

- Per-socket token bucket: chat 5 msg / 3 s, guess 10 / 3 s, strokes 200
  batches / s (well above legitimate use).
- Per-IP room creation: 3 / minute via `SETNX room_create:<ip> EX 60`.
- Global room cap enforced at directory level.
- Max stroke points per batch: 64 (drop frame if exceeded).
- Max chat message length: 256 chars.

These are sized to be invisible to honest users and painful to spammers.

---

## 15. Observability

Each node exports Prometheus metrics on `/metrics`:

- `pastel_rooms_active{node}`
- `pastel_ws_connections{node}`
- `pastel_room_msgs_total{type, room=<bucketed>}`
- `pastel_fanout_latency_seconds{quantile}`, p50, p95, p99 from stroke
  ingress to last subscriber write.
- `pastel_snapshot_duration_seconds{quantile}`
- `pastel_broadcast_lag_drops_total{reason}`

A Grafana dashboard JSON checks into `ops/grafana/`. Reviewers will look for
this.

---

## 16. Deliberately deferred

Listed here so reviewers know what was considered and chosen not-now:

- **Cross-node room migration** without dropping clients. Not worth the
  complexity for a casual game.
- **Multi-region** deployment with geo-routing. Single-region is fine to 10k.
- **Persistent game replays.** Postgres + a `replays` table when there is a
  product need.
- **Spectator mode** beyond "join as non-drawer." The protocol already
  supports it; UI work is the only blocker.
- **Word-list customization.** Static list in v1.
- **Server-side stroke smoothing.** Renderers do it; no need to spend CPU
  centrally.

---

## 17. Build order

1. **`pastel-proto` crate**, `ClientMsg` / `ServerMsg` enums, `Point`,
   `postcard` round-trip tests. No I/O.
2. **`pastel-room` crate**, `Room` struct, task loop, `broadcast` + `mpsc`
   fanout, guess routing. Driven by unit tests. No networking.
3. **`pastel-server` binary**, `axum` + WS, wires connection tasks to room
   tasks. **Single-node, no Redis yet.** Goal: two browser tabs draw on each
   other's canvas.
4. **Web client**, canvas with quadratic-Bézier smoothing, jitter buffer,
   reconnect with `resume_from`.
5. **Chat + guess UI.**
6. **LiveKit integration**, token minting, JS SDK on client.
7. **Redis: heartbeats + node registry + snapshots.** Single node still owns
   all rooms, but failover works.
8. **Gateway**, `/rooms`, `/join/:c`, HRW resolution. Move to multi-node.
9. **Load test**, Rust binary spawning N fake clients drawing + chatting.
   Target: 10k concurrent on one beefy VM or a small cluster.
10. **Metrics, dashboards, chaos demo** (`kill -9` a node, room recovers in
    ~2 s with state intact, recorded as a GIF in the README).

Stages 1–5 are the path to "this is a real product." Stages 6–10 are the path
to "this is a portfolio piece."
