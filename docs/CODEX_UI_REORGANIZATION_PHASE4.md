# Codex navigation and branding refresh

Branch: `feat/codex-only`. Baseline: `5c769ab1`.

## Requested behavior

- Home has parallel account and usage views. Connection configurations live in
  Settings. Long navigation labels become compact icons with accessible names,
  hover titles, selected states and keyboard navigation.
- The account page has no repeated large heading or introductory text block.
  A question-mark popover explains current versus default accounts, restarting
  Codex after a switch, and quota/reset semantics.
- App and tray icons use an original terminal prompt mark. Product UI no longer
  links to the original project's website, releases, sponsorship or update flow.

## Implementation map

| Files | Change |
| --- | --- |
| `src/App.tsx`, `components/settings/SettingsPage.tsx` | Home Accounts/Usage tabs, Settings configuration slot, compact settings tabs, remove redundant app selector/Usage shortcut. Provider actions and account-to-configuration binding still use existing handlers. |
| `components/usage/HomeUsageDashboard.tsx` | Reuse the settings autosave path for refresh and session scanning preferences, including rollback after failure. |
| `components/codex/CodexAccountsPanel.tsx`, `components/providers/forms/CodexOAuthSection.tsx` | Compact status/help/actions; preserve cards' account identity, current/default badges, independent quota and reset values, loading/reauthentication guards and original callbacks. The non-card authentication presentation remains available. |
| `components/branding/CodexSwitchMark.tsx`, `assets/icons/codex-switch*.svg`, `scripts/generate-app-icons.mjs` | Shared vector design plus reproducible PNG/ICO/ICNS/platform/tray resources. ICNS records are sorted to avoid nondeterministic container ordering. |
| `components/proxy/RoutingActivationBrand.tsx` | Non-link product mark; preserve routing activation status and reduced-motion behavior. |
| `components/settings/AboutSection.tsx`, `FirstRunNoticeDialog.tsx`, locales, `src/index.html` | New branding, favicon and welcome mark; remove upstream website/GitHub/star/releases controls; preserve Codex CLI installation/version management. |
| `components/DatabaseUpgrade.tsx` | Show compatible-build/backup guidance and local configuration-folder/quit controls. Do not send a database-incompatible fork to an unrelated upstream updater. |
| `config/buildMode.ts`, `contexts/UpdateContext.tsx`, `lib/updater.ts`, native `lib.rs`, `commands/settings.rs`, `commands/misc.rs`, `tauri.conf.json` | No automatic application update channel until this fork has its own release channel. No upstream endpoints or external release fallback. Existing command signatures remain available with disabled results/errors. |
| Native `tray.rs` and manifest | Remove upstream website menu action, update product display name/tooltip and package description. |

## Compatibility boundary

OAuth/token refresh and rotation, account lifecycle locks, quota caches, account
binding resolution, provider switching, auth ownership and atomic writes are
unchanged. No real account was switched, imported, removed or reauthenticated.

The existing bundle identifier, data locations, database records, deep-link
compatibility and OS auto-launch identity remain unchanged. Renaming these would
require a separate migration; leaving their internal identifiers intact prevents
duplicate startup entries and data appearing to disappear. LICENSE and author
attribution remain. Retained backend modules and hidden translations are not
deleted simply because their names reference upstream products.

## Validation

- All workers and the independent reviewer used GPT-6.1 Sol with high reasoning.
- `pnpm typecheck` and `pnpm test:unit`: 147 files / 1,627 tests passed.
  Tests cover navigation and configuration operations, accessible icon tabs,
  account help/focus behavior, preferences persistence/rollback, absence of
  unrelated live-sync/plugin/autolaunch calls, local database recovery and
  disabled upstream app updates.
- `cargo check` and `cargo test`: 3,162 passed, 9 existing ignored tests.
- `pnpm dev` ran with a new empty isolated profile under
  `/tmp/codex-ui-refresh-validation/dev-home` and identifier
  `com.codexswitch.ui-smoke`. Browser checks verified Home/Usage, Settings/Connections,
  About and help open/Escape-close. Browser-only checks have no native IPC.
- A temporary fixture with fabricated accounts validated quota cards in light
  mode and dark mode at the application's 900px minimum width. No horizontal
  overflow or hidden actions were observed. The fixture was removed from source.
- The icon generator produced identical hashes for 54 assets on repeated runs;
  the generated ICNS decoded successfully. The new application PNG was visually
  inspected.
- `pnpm build:preview` passed, including renderer build, native bundle, actual
  identifier/no-URL-scheme assertions and ad-hoc signature verification. The
  packaged ICNS hash matches the new source icon.
- Independent review found no remaining blocking issues. Protected authentication,
  quota, provider-switch and live-write services have no diff from the baseline.

The updated isolated macOS preview is built with `pnpm build:preview`; it uses
the same persistent preview profile introduced in phase 3B. Real account switching
and OS-native visual automation are not claimed as verified in this phase.
