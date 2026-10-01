# Architecture and compatibility

## Product entry points

`src/main.tsx` initializes errors, window activity, pricing synchronization and
React Query, then mounts `src/App.tsx`. The product surface is Codex Home
(accounts and usage) plus Settings (including connection configurations).
`src/config/productShell.ts` constrains restored navigation, apps and provider
imports. The tray independently restricts visible app/profile choices to Codex.

Frontend pages for MCP, Skills, prompts, sessions, agents, universal providers and
profile management have been retired. Their native services and persisted data
remain available to shared startup, import/export and recovery code. Codex request
usage can still be derived from native session scanning; retiring the session
browser does not remove that scanner.

## Shared behavior

The capability registry, API types, provider/config utilities, settings and database
schemas still recognize legacy applications. Surviving shared hooks and presets
must be assessed by their consumers, not their names. Codex supports native
Responses as well as local Chat/Anthropic protocol translation.

Authentication flows live in `src-tauri/src/commands/codex_oauth.rs` and
`src-tauri/src/proxy/providers/codex_oauth_auth.rs`. Account lifecycle locks,
token rotation, account bindings and quota caches remain separate from the UI.
Configuration switching continues through `src-tauri/src/services/provider`,
with ownership checks and atomic writes. Database compatibility and existing
recovery logic are retained.

The internal crate/package names, `com.ccswitch.desktop`, `ccswitch` deep-link
scheme and existing data paths are compatibility identities. Renaming them
requires a migration rather than a text replacement.

## Packaging

Application updates are disabled in the native backend. The frontend has no
updater provider, badge or updater plugin dependency. Native command signatures
remain compatible. There is no release channel configured for this fork.

`scripts/build-codex-preview.mjs` pairs the renderer preview flag, native
`codex-preview` feature and `tauri.preview.conf.json`. The native executable
initializes the isolated preview home before startup, including Finder launches.
The preview is macOS-only and ad-hoc signed; path overrides are not confined by
an OS sandbox.

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

This cleanup does not migrate database records, remove user files or invoke real
account actions. Test success does not certify live OAuth refresh, account
switching or Codex Desktop behavior.
