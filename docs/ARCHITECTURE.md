# Architecture and compatibility

## Product entry points

`src/main.tsx` initializes errors, window activity, pricing synchronization and
React Query, then mounts `src/App.tsx`. The product surface is Codex Home
(accounts/connections and usage) plus Settings (global policies and preferences).
`src/config/productShell.ts` constrains restored navigation, apps and provider
imports. The tray independently restricts visible app/profile choices to Codex.

Frontend pages for MCP, Skills, prompts, sessions, agents, universal providers and
profile management have been retired. Their native services and persisted data
remain available to shared startup, import/export and recovery code. Codex request
usage is derived from native session scanning and existing historical records;
retiring the session browser does not remove that scanner. No request listener
runs to collect new proxy logs.

Codex Token scanning resolves its input root independently from writable client
configuration. `codexUsageSourceDir` overrides only session scanning and its
database cursors; auth, provider changes and session-history migration continue
to use the Codex configuration root. Preview builds default the read-only input
to the real user's `~/.codex`, while keeping the database under the preview home.

## Shared behavior

The capability registry, API types, provider/config utilities, settings and database
schemas still recognize legacy applications. Surviving shared hooks and presets
must be assessed by their consumers, not their names. Codex supports native
Responses connections. Local request listening, failover and protocol conversion
are removed; saved legacy records remain in the database and editor. The provider
service validates direct compatibility before activation and rejects unsupported
connections without rewriting their protocol.

Authentication entry points live in `src-tauri/src/commands/auth.rs`;
token rotation lives in `src-tauri/src/auth/codex_oauth.rs`. Account lifecycle locks,
token rotation and quota caches remain separate from the UI. Codex accounts are
independent of API Provider records. Current selection is an account, an API
Provider, or disconnected, committed with the recoverable native write operation.
Configuration switching continues through `src-tauri/src/services/provider`,
with ownership checks and atomic writes. Native API-key connections generate
`model_catalog_json` when configured, including DeepSeek's official catalog
profile and per-model overrides. The form's direct preset policy filters the
legacy preset array without changing its persisted indices. Database compatibility
and existing recovery logic are retained.

macOS and Windows use the same account, configuration, usage and settings
contracts. Native adapters handle title bars, tray presentation and startup
registration. A shared quota snapshot and renderer determine the account,
remaining windows, thresholds, unknown state and stale state on both platforms;
platform UI must not change those values or refresh rules. Settings navigation
uses Cmd+, on macOS and Ctrl+, on Windows. Retired session-management commands
are outside the current product surface.

Codex OAuth persistence stages and syncs a complete private credential file,
then uses the shared atomic replacement operation. Windows never deletes the
previous account file before publication. Failed replacements retain existing
credentials and remove the unused staging file. Windows startup commands quote
the executable path; regular and preview builds have distinct startup entries.

Startup runs a one-way migration of historical local takeover state through
`src-tauri/src/mode/controller.rs`. It settles interrupted publications through
`src-tauri/src/mode/operation.rs`, restores a compatible saved direct connection
when available, and retires owned proxy markers/contracts and historical enable
flags. Unsupported saved provider records retain their protocol and metadata;
the migration does not make them native-compatible. Legacy takeover backups are
archived locally before being retired. No startup path opens a request listener.

`src-tauri/src/switch_lock.rs` serializes account/configuration writes independently
of routing. `src-tauri/src/http_client.rs` manages outgoing HTTP using the system
network environment. Application proxy configuration, scanning and testing have
been removed; previously saved proxy URLs are ignored. Historical routing types
in `src-tauri/src/legacy_routing.rs` remain only to read persisted schemas and
settings.

The package and binary are `codex-switch`; the Rust library is `codex_switch_lib`.
Regular builds use `com.codexswitch.desktop` and the `codexswitch` deep-link
scheme. Preview builds keep `com.codexswitch.preview` and register no external
URL scheme. The product stores visible browser preferences under
`codex-switch-*`. A one-time copy migrates legacy preferences available in the
same WebView, preserves existing new values and removes each source key only
after a successful copy. A new application identity can have a separate WebView
storage context; the application does not read another app's browser storage.

`src-tauri/src/app_data_migration.rs` imports legacy application files before
settings, logging, authentication and database initialization. It creates a
SQLite backup including WAL data, checks its integrity, preserves a recovery
snapshot and publishes without replacing existing destination files. The source
is retained; custom directory locations are preserved. See
[configuration behavior](CONFIGURATION.md) for paths and conflict handling.

## Packaging

Application updates are disabled in the native backend. The frontend has no
updater provider, badge or updater plugin dependency. Retained account and
configuration commands remain available; local routing commands are removed.
This fork publishes macOS Apple Silicon pre-releases through GitHub Releases;
updates use manual downloads.

`scripts/build-codex-preview.mjs` pairs the renderer preview flag, native
`codex-preview` feature and `tauri.preview.conf.json`. The native executable
initializes the isolated preview home before startup, including Finder launches.
macOS previews are ad-hoc signed. Windows previews use a separate NSIS installer
and application identity; path overrides are not confined by an OS sandbox.
Native fixture runs must set an explicit temporary Token source when session
scanning is enabled; the preview's default source observes real local logs.

`scripts/generate-app-icons.mjs` generates the app/platform/tray resources. The
source assets are separate from discarded upstream marketing screenshots.

## Cleanup boundary

Retired frontend modules were checked through the static dependency graph from
`src/main.tsx`, source/test imports, export barrels and dynamic import searches.
Their dedicated tests were retired; mixed tests retain shared and Codex cases.
Unused dependencies were removed together with their lockfile entries.

Old upstream manuals, guides, release notes and phase reports have been replaced
by current setup, configuration and architecture documentation. Git history
retains those records. LICENSE and attribution remain.

Real API Provider records and user-created TOML are retained; obsolete Codex
account bindings and account-shaped Provider rows are migrated away. Startup changes legacy
takeover state and live configuration through the existing write/recovery engine;
this is an explicit one-way migration, not a provider-protocol conversion. Tests
use fixtures and do not certify live OAuth refresh, account switching, vendor API
availability or already-running client behavior.
