# Codex account home: phase 2

Branch: `feat/codex-only`. Baseline: `a23de6ed`.

## Scope and audit

The user confirmed that OpenAI login and binding a homepage configuration to an
account work in phase 1. This phase reorganizes the interface around ChatGPT
accounts before removing unrelated implementations.

| Area | Change |
| --- | --- |
| `src/App.tsx` | Make accounts the initial home view; retain saved providers under Connection configurations; expose Usage without requiring proxy takeover. |
| `src/components/codex/CodexAccountsPanel.tsx` | Present account-specific quota and switching through existing explicitly bound Codex providers. |
| `src/components/codex/accountProviders.ts` | Resolve explicit managed-account bindings with existing Codex identity helpers; never infer current from default. |
| `src/components/providers/forms/CodexOAuthSection.tsx` | Add a card presentation while reusing the same account and device-code lifecycle. |
| `src/components/providers/AddProviderDialog.tsx`, `src/components/providers/forms/ProviderForm.tsx` | Let an account card open the existing configuration form with that account selected. |
| `src/i18n/locales/{en,zh,zh-TW,ja}.json` | Translate account navigation, state, and configuration guidance. |
| `src/components/CodexOauthAccountQuota.tsx`, `src/components/SubscriptionQuotaFooter.tsx` | Present the correct in-app reauthentication hint for expired managed accounts, keeping shared CLI hints as the default. |
| Focused account/form/App tests | Verify identity mapping, independent default/current states, existing switch callbacks, and configuration preselection. |

## Boundaries and risks

- `CodexOAuthManager`, refresh/rotation/generation protection, lifecycle locks,
  quota cache, auth ownership and atomic live writes remain unchanged.
- Existing `useManagedAuth`, provider switching, subscription queries and shared
  networking remain the source of behavior. Cards query quota by explicit account
  ID, never by the current or default account as a substitute.
- Default OAuth account is distinct from the current provider. Native login and
  API configurations must not label the default managed account as current.
- During takeover with automatic failover, the actual active target determines
  the current account. A missing target is unknown, not the configured provider.
- If an account has several bound configurations, the user chooses which to use.
  No existing provider is silently rebound to another account.
- Missing bindings open the existing configuration form; removed account
  bindings remain repairable in Connection configurations.
- Backend and other harness code are retained. Live account refresh and actual
  CLI/Desktop switching require separate end-to-end acceptance; fixtures cannot
  prove these external behaviors.

## Validation

- Account tests cover independent default/current state, exact binding matching,
  native/API identities, multiple configurations, status errors, loading,
  switching and reauthentication restrictions, and preserved lifecycle callbacks.
- App tests cover the account/configuration tabs, keyboard navigation, independent
  Usage entry, routing/failover readiness and the existing switch callback.
- Form tests cover account preselection in React StrictMode and rejection when
  the selected account is missing or account status cannot be loaded.
- A synthetic-account browser fixture verified distinct 5h/weekly/reset values,
  the current badge moving independently from default, expired-account guidance,
  light/dark rendering and two columns at the native minimum width of 900 pixels
  without horizontal overflow. Temporary fixture files were removed from source.
- The running isolated `pnpm dev` instance served the updated renderer. Browser
  checks also exercised the account/configuration navigation in the actual App.
  Browser-only App checks do not provide Tauri IPC or real authentication proof.
- No Rust, OAuth hook, quota query/cache, account lifecycle, or live-write source
  changed. Rust checks passed: `cargo check`; `cargo test` with 3162 passed and
  9 existing ignored tests.

- Final `pnpm typecheck` passed; `pnpm test:unit` passed 156 files / 1754 tests.
  Prettier checks for every changed TypeScript/JSON file and `git diff --check`
  passed. All new keys are translated in the four supported locales.
- Independent GPT-6.1 Sol review found no remaining blocking issues after
  StrictMode, provider readiness and keyboard-navigation fixes.
- Real multi-account refresh and CLI/Desktop switching remain separate live
  acceptance checks. This phase preserves their implementation and reports only
  the fixture, source-review, browser-layout and automated-test evidence above.
