# Codex Switch

Codex Switch manages Codex connection configurations, ChatGPT accounts and usage.
It is a Codex-focused fork of CC Switch, built with Tauri 2, React, TypeScript and
Rust. [中文说明](../README.md).

- Home contains directly switchable ChatGPT accounts, independent subscription quota and local Codex usage.
- Settings contains connection configurations, authentication, routing, backups,
  synchronization and application preferences.
- Signed-in accounts need no manually created connection; adding one does not switch the active account. The pencil edits the local display name, notes, icon and color, which persist across restarts.
- “Current” follows a successful switch. Default-account controls live under advanced options; API keys and existing advanced connections remain in Settings.

## Run from source

Use the Node version in [.node-version](../.node-version), pnpm 10.12.3 and the Rust
toolchain in [rust-toolchain.toml](../rust-toolchain.toml). Native builds also need
the platform's Tauri development dependencies.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` uses the regular application profile and can operate existing Codex
configuration. For an isolated local macOS bundle:

```sh
pnpm build:preview
open "src-tauri/target/debug/bundle/macos/Codex Switch Preview.app"
```

The preview uses `~/.codex-switch-preview`, identifier `com.codexswitch.preview`
and no registered external URL scheme. The script pairs the renderer flag,
native feature and bundle overlay, then verifies metadata and an ad-hoc signature.
Do not use the overlay alone or import a live profile's credentials into it.
Directory overrides can point outside the preview profile.

## Development

```sh
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

See [contribution instructions](DEVELOPMENT.md), [configuration behavior](CONFIGURATION.md)
and [architecture and compatibility](ARCHITECTURE.md).

## Distribution and attribution

This fork has no published automatic update channel. The macOS preview is a local
ad-hoc signed debug bundle; it is not a notarized release. The version number and
internal `cc-switch` identifiers are retained for compatibility and do not mean
this fork is an upstream release. Old upstream release, download-mirror and
sponsorship machinery has been removed.

Derived from CC Switch by Jason Young and contributors. Original copyright and
MIT terms remain in [LICENSE](../LICENSE).
