# pastel

Real-time, room-based collaborative drawing + guessing. No accounts.
Strokes feel like ink. Voice in every room.

## Workspace

```
crates/
  pastel-proto/    wire types, postcard codec, validation
  pastel-room/     per-room actor task
  pastel-server/   axum + WS binary
```

## Requirements

- Rust stable (edition 2021). Install via [rustup](https://rustup.rs/).
- Components: `rustfmt`, `clippy`. Both ship with the default stable toolchain.

## First-time setup

```sh
git clone <this repo>
cd skribble
git config core.hooksPath .githooks
```

The hooksPath line points git at the in-repo `.githooks/pre-commit`, which
runs `cargo fmt --check` whenever you stage `.rs` files.

## Dev

```sh
cargo build --workspace
cargo test  --workspace
cargo run -p pastel-server
```

Format and lint before pushing:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
```

## CI

`.github/workflows/backend.yml` runs three parallel jobs on push to `main`
and on pull requests that touch backend paths:

| Job    | Command                                                       |
|--------|---------------------------------------------------------------|
| fmt    | `cargo fmt --all -- --check`                                  |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings`       |
| test   | `cargo test --workspace --all-targets`                        |

All three must pass to merge.
