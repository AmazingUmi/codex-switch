# Changelog

## 0.0.3 — Account and Provider separation (2026-10-03)

- Activate subscription accounts independently and show subscription quota only
  on account cards. API Providers contain API configuration and API balances.
- Give both sections independent Add buttons; move API creation into Providers.
- Remove Providers, including the active one, with saved credentials and balance
  state. Sign-out clears account credentials and quota state.
- Clean up legacy account bindings and orphan Provider cards while preserving
  valid accounts and API-key connections.

## 0.0.2 — macOS Pre-release (2026-10-03)

- Add a tag-driven macOS Apple Silicon release build, artifact verification,
  checksums and draft pre-releases in this fork's GitHub Releases.
- Check the installed ChatGPT desktop app version without launching or updating it,
  and link the application title to this fork's repository.
- Align CI with the declared Node and Rust toolchains and resolve native lint
  failures while preserving IPC signatures and compatibility fixtures.

- Share account-scoped quota refreshes between Home and the menu bar, with a
  configurable refresh interval and retained success timestamps on transient errors.
- Keep available quota visible when switching to accounts with only a weekly
  limit, and add a compact ring-only menu-bar option.
- Unify settings typography and capsule controls, add a battery threshold slider,
  and prevent glass-control shadows from being clipped by scroll containers.
- Add equal-height source/model statistics cards with switchable cost/token
  comparisons, soft gradient rings, totals and accessible legends.
- Use Codex Switch product identifiers, independent application directories and
  a one-time migration for visible browser preferences. Remove inherited
  affiliate links and promotional partnership claims.
- Switch signed-in OAuth accounts directly, reusing existing bindings without
  changing the active account on login. Recover interrupted writes before
  reporting success; suppress current-account labels when state cannot be confirmed.
  Reject unsupported credential stores before publishing a misleading account switch.
- Persist account display names, notes, icons and colors independently of login
  credentials, and share account operations between Home and Authentication.
- Separate API-key/advanced connections from daily account management. Show
  independent quota refresh, unknown and stale states with compact glass cards
  and quota rings in both themes.
- Restrict the product surface to Codex accounts, usage, connection configurations
  and Settings, with compact navigation and updated application/tray branding.
- Add a macOS preview bundle with an isolated default profile and verified bundle
  identity, external URL-scheme isolation and local ad-hoc signature.
- Remove retired frontend pages, form hooks, API wrappers and updater scaffolding,
  their dedicated tests and unused dependencies.
- Replace upstream multi-application manuals, marketing, release notes and phase
  reports with current project documentation. Remove upstream release/mirror
  workflows, publishing scripts, Flatpak metadata and external support routing.
- Retain shared native services, database compatibility, account/credential
  handling, protocol translation and the original MIT license.

This pre-release uses the regular application profile and does not include an
automatic update channel. The initial build is ad-hoc signed and not notarized;
it targets Apple Silicon only. The configured minimum is macOS 12, but macOS 12,
Intel and Retina visual checks remain unverified on actual devices.
The inherited upstream `3.20.4` version remains part of the project history.
Historical upstream release notes and implementation reports remain in Git history.
