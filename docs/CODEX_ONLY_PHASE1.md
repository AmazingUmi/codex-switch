# Codex-only product shell: phase 1

Branch: `feat/codex-only`. Baseline: `7c0d0fc6`.

## Scope and audit

This phase limits the visible product to OpenAI Codex / ChatGPT account management,
quota monitoring, Usage, Settings, and the tray. It does not remove other harness
implementations or migrate/delete their stored data.

| Files / area | Planned change |
| --- | --- |
| `src/config/productShell.ts` | Separate product UI allowlist from shared harness capabilities. |
| `src/App.tsx`, `src/components/AppSwitcher.tsx` | Open Codex regardless of legacy selected app or visibility settings; constrain restored views/events and remove unrelated navigation. |
| `src/components/DeepLinkImportDialog.tsx` | Reject imports outside the supported product surface before opening the dialog. |
| `src/components/providers/forms/ProviderForm.tsx`, `ProviderPresetSelector.tsx` | Limit new product presets to OpenAI/ChatGPT while retaining the existing provider editor, binding, and switch service. |
| `src/components/settings/SettingsPage.tsx`, `AuthCenterPanel.tsx` | Show Codex settings and the existing ChatGPT OAuth account controls. |
| `src/components/settings/DirectorySettings.tsx`, `AboutSection.tsx` | Show only Codex directories, CLI version and installation commands. |
| `src/components/settings/ProxyTabContent.tsx`, `src/components/proxy/ProxyPanel.tsx` | Limit visible proxy/failover controls to Codex and keep global HTTP proxy settings. |
| `src/components/usage/UsageDashboard.tsx` and reachable usage panels | Scope requests, filters, source/model selectors and details to Codex. |
| `src-tauri/src/tray.rs` | Show and refresh only Codex; restrict profile menus/events to the Codex scope. |
| Related frontend and tray tests | Cover legacy navigation/visibility, unsupported entry points, scoped queries and preserved Codex workflows. |

## Shared code retained

- `src-tauri/src/proxy/providers/codex_oauth_auth.rs`: `CodexOAuthManager`, refresh tokens,
  token rotation and login generation protection, account lifecycle synchronization.
- `src-tauri/src/commands/codex_oauth.rs` and existing OAuth frontend hooks/components:
  account add/remove/reauthentication/default selection and account-specific quota.
- `src-tauri/src/services/subscription.rs`, usage/quota caches, and account query keys:
  native CLI quota fallback, independent account quota, window/reset information.
- `src-tauri/src/proxy/http_client.rs` and global proxy configuration: shared networking.
- Provider/auth bindings, `services/provider/codex_direct.rs`, `codex_editor.rs`,
  `codex_login.rs`, live config, `codex_config.rs`, and mode services: CLI/Desktop
  switching, ownership checks, locking, recovery and atomic config/auth writes.
- Database schemas, harness enums, stored settings, backend commands and startup
  recovery for existing state. Their removal requires a later dependency audit.

Switching continues through the existing provider service. No direct overwrite of
`~/.codex/auth.json` is introduced.

## Risks and acceptance evidence

1. Legacy localStorage, persisted visibility, deep links and tray events can bypass
   visual hiding. Guard product entry points rather than changing only defaults.
2. Usage must filter at the query boundary; hiding filter buttons alone mixes data.
3. Quota is account-specific, separate from request usage. Preserve account IDs in
   query/cache keys and test multiple accounts with distinct windows/reset values.
4. Default OAuth account and current Codex provider are distinct concepts. Preserve
   both actions and the provider binding/switch workflow.
5. Text in About, bulk-install commands, provider presets and translated strings
   can expose other products even after navigation is narrowed.
6. Tests and dev startup must use isolated data where they could modify live files.
   Automated fixtures cannot establish successful login/refresh against a real
   user's ChatGPT accounts; live end-to-end acceptance must be reported separately.

Required validation after implementation: `pnpm typecheck`, `pnpm test:unit`,
`cargo check`, `cargo test` in `src-tauri`, and a `pnpm dev` smoke run.

## Baseline

- TypeScript typecheck passed.
- Frontend: 148 test files, 1697 tests passed.
- `cargo check` passed using the repository's Rust 1.95 toolchain.
- Rust baseline passed after allowing local mock HTTP listeners: 3162 tests
  passed, 9 existing ignored tests. The initial sandbox denied 48 listener-based
  tests; no code change was needed to resolve those failures.

## Implementation details

- Product navigation is restricted to providers and Settings (including Auth and
  Usage). MCP, Skills, Agents, Universal, Sessions, workspace and harness-specific
  views are retained in code but cannot be restored or opened from this shell.
- `AddProviderDialog.tsx`, `EditProviderDialog.tsx`, `CodexFormFields.tsx` and
  `CustomUserAgentField.tsx` pass/enforce presentation restrictions without changing
  saved auth bindings or existing upstream formats.
- `UsageScriptModal.tsx` hides unrelated template/provider pickers while retaining
  saved script state and its existing query/save behavior.
- `WindowSettings.tsx` hides legacy integration/onboarding controls;
  `GlobalProxySettings.tsx` uses product-appropriate wording.
- `UsageHero.tsx` now queries a Codex-scoped summary. `UsageTrendChart.tsx`,
  `RequestLogTable.tsx`, `ProviderStatsTable.tsx` and `ModelStatsTable.tsx` enforce
  that same scope, even if passed a legacy all-app value.
- `PricingConfigPanel.tsx`, `PricingEditModal.tsx`, `ModelsDevPickerDialog.tsx`,
  `ModelsDevAutoSyncPanel.tsx` and `codexPricing.ts` narrow visible pricing/model
  choices while retaining custom model aliases and stored shared pricing data.
- `package.json`, `src/index.html` and all four locale files remove multi-harness
  product descriptions from the reachable UI. Upstream release notes remain an
  external link instead of being embedded in About.
- The only changed Rust file is `src-tauri/src/tray.rs`; OAuth/token, provider
  lifecycle, quota cache, shared networking and live write implementation files
  have no changes.

## Deliberately retained compatibility

The backend still understands existing harness data and commands. Settings retain
hidden stored values. Background session scanning, model-pricing synchronization,
startup recovery, and shared import/export remain the existing implementations.
The product UI filters their displayed results. Other harness code and the shared
schemas have not been deleted.

The current updater configuration still points at upstream CC Switch. A future
release/distribution phase must decide the fork's update channel before shipping
this as a separately maintained product.

## Verification limits

`pnpm dev` was launched with a separate temporary home and application identifier,
including a legacy `visibleApps.codex = false` setting. Vite and the native app
started; logs confirmed the main window, Codex OAuth manager and shared HTTP client
initialized. Native accessibility tooling could not attach to the unbundled Tauri
process, so this is startup evidence, not a complete visual inspection.

Account fixtures cover existing account lifecycle/binding tests plus separate 5h,
weekly and reset values for two accounts, independent refresh, and clearing prior
account quota while a different account loads. Live ChatGPT login/token refresh
and switching actual Codex CLI/Desktop sessions have not been exercised with real
accounts. Those remain end-to-end acceptance checks; no real credentials were
needed for this validation.

## Final validation

- `pnpm typecheck`: passed.
- `pnpm test:unit`: 155 files / 1733 tests passed, including retained shared-harness
  tests and new product-boundary, settings, quota, pricing and preset regressions.
- Changed TypeScript/JSON files pass Prettier; `git diff --check` passes. All new
  reachable product-shell translation keys exist in English, Chinese, Traditional
  Chinese and Japanese.
- `cargo check`: passed. `cargo test`: 3162 passed across 17 suites,
  9 existing ignored tests. No new ignored/skipped tests were introduced.
- `rustfmt --check --edition 2021 src-tauri/src/tray.rs`: passed.
- Independent GPT-6.1 Sol review found no remaining blocking findings in the
  reviewed phase-one scope after the pricing, UA, usage-template and About fixes.
- The isolated dev process was stopped after the smoke check. No backend removal
  phase was started.
