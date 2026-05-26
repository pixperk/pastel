# pastel

Real-time, room-based collaborative drawing. No accounts. Strokes feel like
ink. Voice coming in a later phase.

A Rust + WebSocket backend, a TypeScript + 2D-canvas frontend, and a hand-
written `postcard` codec on both sides so the wire format is identical
byte-for-byte.

## What works today

- Multi-player rooms over WebSocket. Up to 10 players per room.
- Drawing with quadratic-Bezier midpoint smoothing, velocity-modulated width,
  and a ~50 ms jitter buffer on remote strokes.
- 6 brushes (pen, nib, pencil, brush, pastel, crayon) plus an eraser.
- 30 colours in three palettes (Basic, Performative, Queen).
- "Clear all" broadcasts to every player in the room.
- Reconnect with `resume_from`, silent during brief WS hiccups.
- Player presence + name remembered across reloads (with a rename prompt
  on every entry).

## Repo layout

```
crates/
  pastel-proto/      wire types, postcard codec, validation, fixtures
  pastel-room/       per-room actor task (broadcast + per-player mpsc fanout)
  pastel-server/     axum + WebSocket binary

frontend/
  src/
    postcard.ts      hand-written postcard codec (Reader / Writer)
    proto.ts         ClientMsg / ServerMsg encoders + decoders
    palette.ts       colour swatches + brush definitions
    toolbar.ts       brush picker, palette tabs, clear button
    canvas.ts        pointer capture, Bezier smoothing, replay model
    ws.ts            WebSocket client with backoff + resume_from
    main.ts          app entry
  tests/
    postcard.test.ts cross-codec round-trips + hex fixtures
```

## Requirements

- **Rust** stable, edition 2021. Install via [rustup](https://rustup.rs/).
  The default stable toolchain ships `rustfmt` and `clippy`.
- **Node** 20+ and **npm** for the frontend.

## First-time setup

```sh
git clone <this repo>
cd skribble
git config core.hooksPath .githooks   # in-repo pre-commit hook
cd frontend && npm install && cd ..
```

The `core.hooksPath` line installs the pre-commit hook that runs
`cargo fmt --check` whenever you stage `.rs` files.

## Running locally

In one terminal, start the server:

```sh
cargo run -p pastel-server
# listens on 127.0.0.1:7070
```

In another, start the Vite dev server (proxies `/ws` to the backend):

```sh
cd frontend && npm run dev
# serves http://127.0.0.1:5173
```

Open two browser tabs at `http://127.0.0.1:5173`. The page generates a fresh
room code on first load and pins it in the URL — copy that URL to the second
tab and you'll be in the same room. Each tab prompts for a name; on reload it
pre-fills the stored name so you can keep it or rename in one step.

## Testing

Everything is testable from cold-clone, no live server required.

```sh
# Rust workspace (41 tests: proto round-trip, fixtures, room actor, server WS).
cargo test --workspace

# Frontend codec + fixtures (36 tests, cross-codec hex match with Rust).
cd frontend && npm test
```

The cross-codec contract lives in two places:

- `crates/pastel-proto/tests/fixtures.rs` asserts exact hex for several
  representative messages.
- `frontend/tests/postcard.test.ts` asserts the **same** hex.

If you change the wire format on one side, update both. The build is the
canary.

## Lint, format, typecheck

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings

cd frontend
npm run typecheck
npm run build       # vite production bundle, ~8 KB gzipped
```

## CI

`.github/workflows/backend.yml` runs three parallel jobs on push to `main`
and on PRs touching backend paths:

| Job    | Command                                                  |
|--------|----------------------------------------------------------|
| fmt    | `cargo fmt --all -- --check`                             |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings`  |
| test   | `cargo test --workspace --all-targets`                   |

All three must pass to merge. Frontend CI is on the to-do list.

## Wire protocol, briefly

One enum per direction (`ClientMsg` / `ServerMsg`), `postcard`-encoded,
binary WebSocket frames. Variant indices and field order are part of the
wire contract; the Rust enum and the TypeScript types must agree.

- Stroke deltas are 4 bytes per point: `dx: i8, dy: i8, dt: u8, pressure: u8`.
- Server assigns a monotonic `seq: u64` to every state-changing message.
- A 30-point stroke batch fits in well under 140 bytes.
- The decoder enforces per-field caps (chat 256 B, name 32 B, points 64 per
  batch, frame 64 KB). Oversize frames close the connection with `BadFrame`.
