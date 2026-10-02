# Codex Switch

Codex Switch manages Codex connection configurations, ChatGPT accounts and usage.
It is a Codex-focused fork of CC Switch, built with Tauri 2, React, TypeScript and
Rust. [中文说明](../README.md).

- Home contains directly switchable ChatGPT accounts, independent subscription quota, API-key and advanced connections, with one add chooser and a separate local usage view.
- Settings contains global authentication policies, backups,
  synchronization and application preferences.
- OpenAI subscription accounts use official login directly. DeepSeek API uses its official native Responses endpoint with an API key; models and reasoning levels remain customizable. Local routing, automatic failover and protocol conversion are unavailable.
- Signed-in accounts need no manually created connection; adding one does not switch the active account. Card icons provide switching and editing. The editor contains display details, reauthentication, default-account controls, account connections and removal.
- “Current” follows a successful switch and is independent of the default account. API keys and existing advanced connections are managed on Home; signing out all accounts is available below its account list. Network requests follow the system environment; application proxy configuration has been removed.
- Help icons beside headings explain quota, statistics scope and settings on hover, keyboard focus or click. Local usage labels costs as estimates.

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

Regular application data defaults to `~/.codex-switch`; preview pricing lives
directly in `~/.codex-switch-preview/model-pricing.json`. First startup backs up
and copies each build's legacy default directory, preserves the source and
rejects destination conflicts. See [configuration behavior](CONFIGURATION.md)
for migration and custom-directory rules.

Token scanning has its own source setting in the Usage auto-scan section. Choose
the Codex root containing `sessions` and `archived_sessions`. Preview builds
default to read-only scans of the real user's `~/.codex`, while statistics remain
in the preview database. Regular builds default to the configured Codex directory.
Leave the source blank to restore the default; save and use Sync Now to verify
without restarting.

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
ad-hoc signed debug bundle; it is not a notarized release. Regular builds use
`com.codexswitch.desktop` and the `codexswitch://` deep-link scheme; preview builds
register no external URL scheme. Upstream release, download-mirror, affiliate
tracking and partner discount claims have been removed.

Derived from CC Switch by Jason Young and contributors. Original copyright and
MIT terms remain in [LICENSE](../LICENSE).
