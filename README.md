# pastel

Real-time, room-based collaborative drawing + guessing. No accounts.
Strokes feel like ink. Voice in every room.


## Workspace

```
crates/
  pastel-proto/    # wire types, postcard codec
  pastel-room/     # per-room actor task
  pastel-server/   # axum + WS binary
```

## Dev

```sh
cargo build --workspace
cargo test  --workspace
cargo run -p pastel-server
```
