# Development

Read [README.md](../README.md) for setup and preview packaging.

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
pnpm build:renderer
```

Format changed frontend files with `pnpm exec prettier --write <files>` and check
with `pnpm exec prettier --check <files>`. For Rust changes, also run:

```sh
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Use `CODEX_SWITCH_TEST_HOME` with an isolated temporary home for native smoke
runs. It isolates default database, OAuth and Codex paths, but not Tauri's
platform preferences; a saved custom directory can override the default. Launch
the executable directly and verify its active data directory. UI automation may
relaunch the app without that environment variable.
Never exercise account switching, reauthentication or migration against a
running user's profile as a cleanup check.
Report live account/CLI/Desktop checks separately from fixture tests.

## Documentation and changes

Keep instructions aligned with the current UI and source. Update the English and
Chinese READMEs when setup changes, and all four locale files when UI text changes.
Keep tests for shared storage and protocol behavior even when their legacy UI is
retired. Remove a retired component's dedicated tests together with the component;
retain relevant assertions from mixed tests.

A pull request should explain the resulting behavior, validation and meaningful
limits. Do not include credentials, account exports or real session content.
