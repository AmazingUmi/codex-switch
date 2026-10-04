# Development

Read [README.md](../README.md) for setup and preview packaging.

## Branches and pull requests

`main` is the integration branch. Start each task from the latest `origin/main`
and use a short-lived `codex/<task>` branch:

```sh
git switch main
git pull --ff-only origin main
git switch -c codex/my-task
```

Push the task branch to `origin`, open a PR targeting `main`, and squash merge
after `CI Required` passes and review conversations are resolved. `main`
requires an up-to-date PR, including for administrators; another person's
approval is optional. Force pushes and deletion of `main` are disabled. GitHub
automatically deletes merged task branches. Existing merge history is retained.

`CI Required` verifies changed-area detection and all relevant frontend, backend
and Windows/WSL2 jobs. A job may be skipped only when its area was unchanged in
a PR; pushes to `main` must pass every job.

Configure each local clone to push to this fork and keep pulls predictable:

```sh
git config --local remote.pushDefault origin
git config --local push.default simple
git config --local pull.ff only
git config --local fetch.prune true
```

After merging, return to `main`, pull, and remove the local task branch after
confirming its PR was merged and there is no unmerged work. Squash merges do not
preserve task commit ancestry, so `git branch --merged` alone cannot identify all
completed branches. `git fetch --prune origin` removes stale remote-tracking refs.

Keep `upstream` as a reference source. Evaluate upstream fixes on a new task
branch and cherry-pick selected commits with `git cherry-pick -x`; validate them
against this fork's product and authentication boundaries. Preserve
`upstream-baseline-2026-09-30` as the original fork point.

Publish versions with `v*` tags on checked commits in `main`, following
[Releasing](RELEASING.md). Keep public tags fixed. Add `release/*` branches only
when multiple released versions need concurrent maintenance.

## Source boundaries

- `src/App.tsx` composes Codex Home and Settings. `src/config/productShell.ts`
  enforces supported apps, views and imports.
- `src/components/providers/forms/ProviderForm.tsx` edits Codex configurations.
  Preserve preset IDs, custom TOML, editor projection and inactive-field handling.
- `src-tauri/src` contains shared storage, recovery, authentication and protocol
  services. A hidden application is not evidence that its backend is disposable.
  See [architecture](ARCHITECTURE.md).

## Checks

```sh
pnpm typecheck
pnpm test:unit
pnpm test:packaging
pnpm build:renderer
```

Format changed frontend files with `pnpm exec prettier --write <files>` and check
with `pnpm exec prettier --check <files>`. For Rust changes, also run:

```sh
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
(
  test_home=$(mktemp -d)
  trap 'rm -rf "$test_home"' EXIT
  CODEX_SWITCH_TEST_HOME="$test_home" cargo test --locked --manifest-path src-tauri/Cargo.toml &&
  CODEX_SWITCH_TEST_HOME="$test_home" cargo test --locked --lib --features codex-preview --manifest-path src-tauri/Cargo.toml
)
```

On Windows, run native tests from PowerShell 7 with the same explicit isolation:

```powershell
$testHome = Join-Path ([IO.Path]::GetTempPath()) "codex-switch-tests-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testHome -Force | Out-Null
$previousHome = $env:CODEX_SWITCH_TEST_HOME
try {
  $env:CODEX_SWITCH_TEST_HOME = $testHome
  cargo test --locked --manifest-path src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "Native tests failed ($LASTEXITCODE)." }
  cargo test --locked --lib --features codex-preview --manifest-path src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "Preview native tests failed ($LASTEXITCODE)." }
} finally {
  [Environment]::SetEnvironmentVariable('CODEX_SWITCH_TEST_HOME', $previousHome, 'Process')
  Remove-Item $testHome -Recurse -Force
}
```

Use `CODEX_SWITCH_TEST_HOME` with an isolated temporary home for native smoke
runs. It isolates default database, OAuth and Codex paths, but not Tauri's
platform preferences; a saved custom directory can override the default. Launch
the executable directly and verify its active data directory. UI automation may
relaunch the app without that environment variable.
Never exercise account switching, reauthentication or migration against a
running user's profile as a cleanup check.
Report live account/CLI/Desktop checks separately from fixture tests.

The Windows Packages workflow builds both variants and checks their native
contracts on Windows. Its installer smoke is restricted to a clean hosted
runner because per-user installation modifies HKCU registration. A passing
cloud build does not certify real login or visual tray acceptance; use the
cross-platform acceptance matrix in [Releasing](RELEASING.md).

## Documentation and changes

Keep instructions aligned with the current UI and source. Update the English and
Chinese READMEs when setup changes, and all four locale files when UI text changes.
Keep tests for shared storage and protocol behavior even when their legacy UI is
retired. Remove a retired component's dedicated tests together with the component;
retain relevant assertions from mixed tests.

A pull request should explain the resulting behavior, validation and meaningful
limits. Do not include credentials, account exports or real session content.
