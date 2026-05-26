# pastel, Roadmap

Phased plan to take pastel from empty repo to deployed portfolio piece.
Each phase has a concrete "done" criterion. Cross-cutting concerns (UI/UX,
ops, docs) are explicit phases, not afterthoughts.

See [DESIGN.md](DESIGN.md) for the architecture this roadmap implements.

---

## Phase 0, Scaffolding *(in progress)*

- Cargo workspace with three crates: `pastel-proto`, `pastel-room`, `pastel-server`.
- `DESIGN.md`, `ROADMAP.md`, `.gitignore` checked in.
- `cargo build` succeeds on a fresh clone.

**Done when:** `cargo build --workspace` is green.

---

## Phase 1, Protocol crate

Build `pastel-proto`:

- `ClientMsg` / `ServerMsg` enums per [DESIGN.md §6](DESIGN.md).
- `Point`, `Seq`, `PlayerId`, `RoomCode`, `RoomSnapshot`.
- `postcard` round-trip property tests via `proptest`.
- Size assertions: a 30-point stroke batch encodes to ≤ 140 bytes.

**Done when:** all message variants encode/decode in tests; size budget met.

---

## Phase 2, Room task

Build `pastel-room`:

- `Room` struct + `tokio` task loop.
- `broadcast` (room-wide) + per-player `mpsc` (unicast) fanout.
- Stroke ingest → `Seq` assignment → ring buffer.
- Chat ring + rate-limit token buckets.
- Guess routing (correct → unicast to guesser + drawer, broadcast hint to others).
- Backpressure: lagged subscribers closed with `Bye::Reconnect`.
- Unit tests using in-memory channels, no networking.

**Done when:** ten simulated players in one room push 1000 strokes; all are
ordered, all subscribers receive them, slow consumer is dropped not blocked.

---

## Phase 3, Single-node server

Build `pastel-server`:

- `axum` HTTP + WS upgrade at `/ws/:room_code`.
- Connection task: WS ↔ `RoomCmd::FromClient` / subscription drain.
- Hardcoded room directory (`DashMap<RoomCode, RoomHandle>`).
- `/healthz`, `/metrics` stubs.

**Done when:** two browser tabs connect to the same room code and see each
other's mouse-drawn strokes in real time. No styling yet, raw lines on a
white canvas. Performance is the deliverable; aesthetics come in Phase 5.

---

## Phase 4, Web client (functional)

Minimal client. TypeScript + Vite + 2D `<canvas>`.

- WS connection, `postcard` encode/decode via generated TS types (or hand-written).
- Pointer capture → 16 ms batching → `ClientMsg::Stroke`.
- Local immediate render of drawer's own strokes.
- Remote stroke render with **quadratic-Bézier midpoint smoothing**.
- Velocity-derived stroke width.
- Jitter buffer (~50 ms) on remote strokes.
- Reconnect with `resume_from` (silent during brief network blips).

**Done when:** drawing feels indistinguishable from a local-only canvas to the
drawer, and remote viewers see inky, smooth strokes with no visible polylines.

---

## Phase 5, UI/UX

This is where pastel earns its name. The product must look intentional.

### Visual language

- **Palette:** muted pastels on near-white background. Five accent colors
  (rose, peach, butter, mint, periwinkle) doubling as default player colors.
- **Typography:** one humanist sans (Inter or Geist) at three sizes. No more.
- **Surfaces:** soft shadows (`0 2px 8px rgba(0,0,0,.04)`), 12 px radii,
  generous whitespace. No hard borders.
- **Motion:** 150–200 ms ease-out for state changes. No bouncy spring physics.

### Screens

1. **Landing.** Centered: app name, "Create room" primary, "Join room" with
   6-char input. Name field above. That's it. No tour, no marketing.
2. **Lobby (pre-game).** Shareable room URL prominent. Player list with
   avatars (auto-generated from name hash). Settings panel: rounds, draw
   time, language. "Start" enabled when ≥ 2 players.
3. **Game room.**
   - **Canvas** centered, ~16:10, max ~960×600.
   - **Player rail** left: avatar, name, score, "guessed" tick.
   - **Chat + guess column** right: scrollback, input bar.
   - **Top bar:** current word slot (blanks for guessers, full word for
     drawer), timer ring, round counter.
   - **Tool palette** under canvas (drawer only): color swatches, 3 brush
     sizes, eraser, undo, clear.
   - **Voice strip** above player rail: mute toggle, talking indicators
     (pulsing ring around avatar of active speakers).
4. **Round transition.** Word reveal centered, scores update with subtle
   count-up animation. 4-second pause before next round.
5. **Game end.** Podium for top 3. "Play again" returns lobby with same code.

### Empty / loading / error states

- Connecting: faint shimmer on canvas + "connecting…" text.
- Disconnected: amber banner "reconnecting, your drawing is safe."
- Room full: redirect to landing with toast.
- Invalid code: inline error on input, no toast.

### Mobile

- Single-column stacked layout below 720 px.
- Canvas drawing supported (`touch-action: none`).
- Chat collapses to a slide-up sheet.

### Accessibility

- All actions reachable by keyboard. Tab order documented.
- Color is never the only signal (player initials shown beside swatches).
- Optional high-contrast mode.
- Screen-reader labels on canvas state ("Alice is drawing. Word has 5 letters.").

**Done when:** the product is visually finished enough to demo without
apologizing for it. A peer who has not seen the design doc can use it
without instruction.

---

## Phase 6, Game loop

- Word list (~500 entries, English) in `pastel-server/data/words.txt`.
- Round state machine: `WaitingForPlayers → ChoosingWord → Drawing → RoundEnd → ...`.
- Drawer picks one of three offered words.
- Timer (server-authoritative).
- Scoring: faster correct guess = more points; drawer scores when guessers do.
- Round end: reveal word, show scores.

**Done when:** a full game (3 rounds × N players) plays end to end without
intervention.

---

## Phase 7, Voice (LiveKit)

- Self-hosted LiveKit in Docker.
- Server SDK in `pastel-server`: create LiveKit room on room create, mint
  JWT on player join, evict on disconnect.
- Client LiveKit JS SDK: connect, mic permission, publish + subscribe.
- UI: mute toggle, speaking indicator on avatars.

**Done when:** four real people in one room can hear each other and play a
full round, with voice surviving a brief network blip.

---

## Phase 8, Redis + snapshots

- Single Redis instance with AOF.
- Periodic room snapshots (5 s during round, immediate on round boundary).
- On node restart: rehydrate owned rooms from Redis.
- Rate-limit token buckets moved into Redis (`INCR` + `EXPIRE`) so they
  survive restart and span future nodes.

**Done when:** killing the server mid-round and restarting recovers every
room with completed strokes intact in ≤ 3 s.

---

## Phase 9, Gateway + multi-node

- `pastel-gateway` binary (separate, stateless): `POST /rooms`, `GET /join/:c`.
- Node heartbeats to Redis (`SET node:<id> ... EX 15`).
- Rendezvous hashing in both gateway and nodes.
- Multi-node deployment via Docker Compose locally.
- Graceful shutdown: snapshot all owned rooms, send `Bye::Reconnect` to all
  WS, exit.

**Done when:** three nodes serve 30 rooms with even distribution; killing one
node migrates its rooms to the other two in ≤ 3 s with no data loss beyond
in-progress strokes.

---

## Phase 10, Load test, observability, chaos demo

- `pastel-loadtest` crate: spawn N fake clients drawing + chatting at
  realistic rates.
- Prometheus metrics on each node ([DESIGN.md §15](DESIGN.md)).
- Grafana dashboard JSON checked into `ops/grafana/`.
- Chaos GIF: `kill -9` a node during active play, room recovers in ~2 s.
- Load test result table in README: connections, msg/s, p95 fanout latency.

**Done when:** 10 000 simulated concurrent users sustained for 10 minutes
with p95 fanout latency under 50 ms.

---

## Phase 11, Deploy + portfolio polish

- Production deployment on a low-cost provider with sane egress pricing
  (Hetzner, Fly, OVH).
- Public demo URL.
- README with: 60-second pitch, screenshot, demo URL, architecture diagram,
  load test numbers, links to `DESIGN.md` and `PROTOCOL.md`.
- `PROTOCOL.md` standalone wire-format spec.
- 90-second screen recording of a real game embedded in README.

**Done when:** sending the repo link to a senior engineer would represent
the work fairly without needing a phone call.

---

## Out of scope (for now)

Listed so reviewers see they were considered:

- Mobile-native clients.
- Accounts, friends, persistent profiles.
- Replays, game history, leaderboards.
- Cross-region deployment.
- Custom word lists per room.
- Drawing tool sophistication beyond solid strokes (fills, shapes, text).

These have clean extension points but no v1 work.
