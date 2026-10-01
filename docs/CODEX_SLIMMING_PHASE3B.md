# Codex-only slimming: phase 3B and isolated macOS preview

Branch: `feat/codex-only`. Baseline: `d9da4d55`.

## Execution and audit boundary

The coordinator assigned two implementation packages and an independent reviewer,
all GPT-6.1 Sol with high reasoning. The user has accepted login and account
binding with Plus and Pro accounts. Actual switching remains untested while live
Codex tasks run; this phase does not invoke switching or migrate credentials.

| Package | Files / change |
| --- | --- |
| Forms | Narrow `ProviderForm`, `AddProviderDialog`, `EditProviderDialog` and `ProviderPresetSelector` to Codex composition. Reject unsupported app inputs before mounting hooks. Keep stable numeric preset IDs and the original Codex preset array. |
| Form leaves | Delete reverse-import-audited Claude, Claude Desktop, Gemini, Grok, Hermes, MCode, OMO, OpenClaw, OpenCode and Pi form components plus unused common/Gemini editors and their direct retired UI tests. Retain the Codex portion of mixed tests. |
| Configurations | Narrow `ProviderList`, `ProviderCard`, `ProviderActions`, and `ProviderEmptyState`; remove non-Codex observers and membership/default actions. Retain sorting, cloning, delete protection, routing, failover, health, usage and supported auth quota formats. |
| Settings | Remove four zero-consumer leaves: `AppVisibilitySettings`, `RectifierConfigPanel`, `SkillStorageLocationSettings`, `SkillSyncMethodSettings`. Stored settings and shared APIs remain intact. |
| Preview package | Add `build:preview`, a paired native feature/config/renderer build, runtime isolated home initialization, and disabled preview app updates. |

## Shared code that remains necessary

- OAuth managers/hooks, refresh and rotation protection, lifecycle locking, quota
  cache, auth ownership, atomic writes, provider switching and account bindings.
- Shared HTTP client, global proxy, subscription services, live config, startup
  recovery and detach logic. No global narrowing of backend `AppType::all` or
  legacy recovery registries.
- Codex native/API/managed configuration, old `openai_chat` and `anthropic`
  upstream formats, Xai binding compatibility, model catalog and custom TOML.
  Protocol names alone are not proof that code is unrelated to Codex.
- Editor base/draft projection, inactive fields and conflict handling. Default
  OAuth account and the actually routed current account remain separate concepts.
- Shared hooks, presets, icons, translations and packages with surviving source
  consumers. This phase does not blindly remove dependencies by product name.

## Standalone preview

On macOS with the project dependencies and Rust toolchain available:

```sh
pnpm build:preview
open "src-tauri/target/debug/bundle/macos/Codex Switch Preview.app"
```

The build script always combines `--features codex-preview`, the preview Tauri
overlay and `VITE_CODEX_PREVIEW=true`. Do not use the overlay alone. The package
is a local debug `.app` with an ad-hoc signature, not a Developer ID signed or
notarized release or a smaller native binary. The script verifies the actual
bundle identity, absence of external URL schemes, and signature.

- Name: **Codex Switch Preview**; identifier: `com.codexswitch.preview`.
- Finder launches initialize a persistent `~/.codex-switch-preview` home before
  the backend starts. Its app data defaults to `.cc-switch` below that home and
  its Codex live configuration defaults to `.codex` below that home. An explicit
  `CC_SWITCH_TEST_HOME` is respected for controlled smoke tests.
- This is an isolated preview: it does not automatically read the running test
  instance's Plus/Pro accounts or operate the real Codex CLI/Desktop configuration.
  Existing user accounts and bindings are not deleted or copied.
- App update checks and installation are disabled: no updater plugin registration,
  no endpoints or updater artifacts, and no automatic/manual UI update request.
- External deep-link schemes are not registered for this preview. Official OAuth
  continues to use the existing loopback callback implementation unchanged.
- Do not import a running instance's database, auth files or path overrides.
  Path overrides can deliberately point outside the preview home; isolation is a
  default profile, not an OS security sandbox. Credential migration requires a
  separate offline/single-writer procedure to prevent token rotation conflicts.

## Risks and release boundaries

Retiring non-Codex UI contracts lowers the test count; Codex and shared backend
tests must still pass without newly skipped tests. Hidden storage for other apps
is deliberately retained for compatibility and recovery. The current preview
builder is macOS-only; other platforms need their own path and launch validation.

Next coordinated packages: audit orphan hooks/resources and stable preset types;
scope new background scans/imports to Codex while retaining legacy recovery;
design offline data migration; then prune backend leaf commands/services and
prepare signed release packaging. These are separate changes, not silently
included in this frontend removal batch.

## Validation

- `pnpm typecheck` and `pnpm test:unit` passed: 145 files / 1,621 tests.
  The baseline was 155 files / 1,745 tests. Deleted tests cover retired non-Codex
  pages; no tests were newly skipped. Four Codex golden snapshots are unchanged.
  Added coverage includes old Codex Chat/Anthropic/custom TOML/xAI configurations,
  rejected non-Codex form inputs, actual route/failover states and disabled preview
  update requests.
- `cargo check` and `cargo test` passed: 3,162 passed, 9 existing ignored tests.
  `cargo test --features codex-preview --bin cc-switch` passed all three added
  preview path tests.
- `pnpm build:renderer` passed. Normal renderer JavaScript decreased from
  4,248,228 to 3,869,119 raw bytes (8.92%); CSS from 91,159 to 87,047 bytes.
  The pre-existing large-chunk advisory remains. This does not measure native
  binary or package slimming.
- `pnpm build:preview` produced `Codex Switch Preview.app`. Actual Info.plist
  identifies `com.codexswitch.preview` and contains no registered URL schemes.
  Debug bundle signing is completed with a local ad-hoc signature and verified.
  The initially inherited static `ccswitch` URLTypes were removed from the source
  Info.plist: regular builds still generate the same protocol from tauri.conf,
  and preview builds use `desktop: []`. A protocol object with empty `schemes`
  is deliberately avoided because this CLI's bundler panics on it.
- The actual bundle executable started with the default preview profile, created
  `~/.codex-switch-preview/.cc-switch/cc-switch.db` and settings, initialized the
  unchanged OAuth manager/shared HTTP client and logged that the main window was
  shown. That empty preview instance was then stopped; the existing dev instance
  remains running. No credential content was read and no accounts were imported.
- The existing `pnpm dev` renderer was checked through the browser for account
  navigation, configuration lists, the add form and Usage. A residual provider
  name example mentioning Claude was changed to OpenAI in all four locales.
  Browser checks lack Tauri IPC. Native window visual automation was blocked by
  macOS Accessibility/Screen Recording permissions, so native visual acceptance
  and real account switching are not claimed.
- Independent GPT-6.1 Sol review passed the final source, dependency boundary,
  test retirement and actual package metadata. Protected OAuth/token/account/
  quota/provider-switch/atomic-write implementations have no diff from baseline.
  Formatting and `git diff --check` pass. No changes are pushed.
