# Codex-only slimming: phase 3A

Branch: `feat/codex-only`. Baseline: `3756c946`.

## Acceptance and scope

The user accepted the account-centered interface after logging in with Plus and
Pro accounts. Actual account switching was deliberately not exercised because
Codex tasks were running. This remains an unexecuted live acceptance check, not a
claimed pass. This phase must not trigger a real switch or rewrite authentication.

This first removal batch narrows the frontend composition and deletes a coherent
set of non-Codex UI leaves. It does not remove shared backend capabilities or
migrate stored data.

## Audited deletion boundary

| Files | Dependency evidence / change |
| --- | --- |
| `src/App.tsx` | Remove unreachable view/navigation/state/handler/import branches. Product navigation already permits only providers and settings. Preserve all reachable Codex behavior and shared event handling. |
| `tests/integration/App.test.tsx` | Remove mocks for deleted App imports and retain/add Codex navigation, account, routing and event regression coverage. |
| `src/components/openclaw/EnvPanel.tsx`, `ToolsPanel.tsx`, `AgentsDefaultsPanel.tsx`, `OpenClawHealthBanner.tsx` | Only external importer is the removed App branch. |
| `src/components/openclaw/utils.ts`, `hooks/useOpenClawModelOptions.ts` | Only used by the deleted OpenClaw pages and the dedicated utility test. |
| `src/components/hermes/HermesMemoryPanel.tsx` | Only App imports this Hermes-specific page. |
| `src/components/proxy/ClaudeDesktopRouteToggle.tsx` | Only App imports this Claude Desktop control; shared proxy hooks stay. |
| `src/components/workspace/WorkspaceFilesPanel.tsx`, `WorkspaceFileEditor.tsx`, `DailyMemoryPanel.tsx` | App imports the parent, which exclusively imports its two children. These operate on OpenClaw workspace/memory, not Codex workspace files. |
| `tests/components/openclaw.utils.test.ts` | Four dedicated cases for the deleted utility module; other OpenClaw/shared tests remain. |

Reverse-import and symbol searches cover source, tests, barrels and dynamic
references. The independent reviewer also checked that the deleted modules have
no required import-time initialization.

## Deliberately retained

- All Rust source and registered backend commands.
- `CodexOAuthManager`, refresh/rotation/generation protection, lifecycle locks,
  quota caches, ownership checks and atomic config/auth writes.
- OAuth hooks, provider actions, auth bindings, subscriptions, live configuration,
  shared HTTP client, global proxy and Codex CLI/Desktop integration.
- `useUsageCacheBridge`, Codex environment checks, migration notifications,
  provider switch events, profile/proxy cache invalidation, universal-provider
  sync/tray refresh and WebDAV/S3 status handling.
- Shared `useOpenClaw`, `useHermes`, API/config/type modules: provider forms and
  other retained modules still depend on them.
- MCP, Skills, prompts and session implementations: these include Codex-capable
  shared code and are not classified as disposable by name alone.
- Provider preset assets, translations and dependencies with surviving consumers.

## Validation and measurements

Baseline renderer build: 4,632,233 raw JavaScript bytes in 3 chunks; 91,919 CSS
bytes. The production build succeeds with the existing large-chunk advisory.

- Removed 11 source files (2,122 lines) and their dedicated four-case utility test
  (46 lines). App composition shrank from 2,056 to 1,106 lines. Total production
  source reduction: 3,072 lines.
- Renderer JavaScript decreased to 4,248,228 raw bytes, a reduction of 384,005
  bytes (8.29%). CSS decreased to 91,159 bytes. This measures frontend assets,
  not the native binary or installer, whose backend has not been slimmed.
- `pnpm build:renderer` passed; the existing large-chunk advisory remains.
- `cargo check` and `cargo test` passed, with 3,162 tests passed and 9 existing
  ignored tests. No Rust files changed.
- The existing `pnpm dev` renderer served the changed App successfully. A
  temporary browser checked accounts, connection configurations, and Usage in
  Settings, then closed. Browser-only checks cannot prove native IPC behavior;
  no smoke action requested real login, switching, deletion or credential
  mutation. The native dev instance was left running with its normal behavior.
- Shared event regressions cover Codex switch refresh/other-app rejection,
  profile/proxy invalidation, provider sync/tray refresh, and provider deletion.
  Generic provider tests now use Codex fixtures without bypassing product policy.

- Final `pnpm typecheck` and `pnpm test:unit` passed: 155 files / 1,745 tests.
  Compared with 1,754 baseline tests, four utility cases and eleven inaccessible
  non-Codex App cases were retired; six consequential Codex App regressions were
  added. No tests were newly skipped or disabled.
- Prettier checks and `git diff --check` passed. The diff for all protected Rust,
  OAuth/hooks/API/query/provider/core source, account/quota components, package
  manifest and lockfile is empty against `3756c946`.
- Independent GPT-6.1 Sol review found no remaining actionable findings in the
  final source/dependency/test changes.

## Next boundary

Provider forms, presets, API/type registries and shared hooks still contain
multi-harness branches. A subsequent batch must audit their Codex dependencies
before narrowing them; they are intentionally not removed in this batch. Backend
schema/command/credential cleanup remains a separate migration-sensitive phase.
