# Configuration behavior

## Accounts and connections

Home displays ChatGPT accounts and their independent quota windows/reset times.
Signed-in OAuth accounts switch directly: the backend reuses a compatible saved
binding or creates a private official connection at switch time. Adding an account
only saves its login and does not replace the active connection. Private account
connections are hidden from Settings → connection configurations; that view keeps
API-key connections and user-created advanced settings. Existing connection rows
and custom TOML are preserved. Multiple compatible bindings can be selected under
the account card's advanced connection control.

The direct account action currently supports file credential storage. It checks
the configuration that would actually be published before writing. Effective
`cli_auth_credentials_store` values of `keyring`, `auto` or `ephemeral`, and
advanced targets explicitly requesting those modes, are rejected with a reason;
their settings and active account are preserved. The application does not write
the OS keyring or inject credentials into another client's memory. API-key and
existing advanced connection operations retain their original paths.

The pencil edits display name, notes, icon and color on the account itself. These
fields persist in the OAuth account store and survive reauthentication without
altering credentials, quota, identity or the active connection. Expired accounts
remain editable and provide a sign-in action. Home and Settings → Authentication
share the same account data and operations. The default account is an advanced
fallback for unspecified managed bindings; it is independent of “Current”.

A successful switch updates live configuration through the provider service.
The UI updates “Current” from committed backend state, without optimistic account
labels. Failed switches show their reason. The application writes local config
and credentials; it does not establish that already-running clients have adopted
them. Reopen a client if it continues showing the old account. Codex supports file,
keyring and in-memory credential caching ([official authentication reference](https://learn.chatgpt.com/docs/auth)).

## Protocols

The Codex editor preserves custom TOML, API keys, account bindings, model catalogs
and existing `openai_chat` / `anthropic` configurations. Local routing translates
those protocols when required. Protocol names such as Anthropic do not imply a
separate Claude application UI.

Provider presets keep their stable `codex-<index>` identities. New preset selection
is restricted by product policy; saved configurations remain editable. Relevant
sources are `src/config/codexProviderPresets.ts`,
`src/components/providers/forms/ProviderForm.tsx` and
`src-tauri/src/services/provider/codex_editor.rs`.

## Official authentication and history

Settings → General includes preserving official authentication during a direct
switch and unifying Codex session history. These are explicit settings; they are
not enabled by the cleanup.

The history control asks whether to migrate existing sessions. When disabled,
it can restore the recorded migration backup. Restoration occurs only after the
setting is saved successfully; the native service checks migration state again.
See `src/components/settings/CodexAuthSettings.tsx`,
`src-tauri/src/codex_history_migration.rs` and `src-tauri/src/codex_state_db.rs`.
The application does not provide a session-management page.

## Usage, storage and recovery

Home → Local usage shows locally recorded Codex requests and scanned sessions,
filtered by time, connection source and model. It does not aggregate other devices
or subscription quota, and cost uses the local pricing table. Account cards show
subscription quota with per-account refresh state. Unknown windows remain unknown;
failed refreshes can show a marked last-success snapshot for up to ten minutes.
Expired credentials immediately clear that snapshot. The usage view also manages refresh
and session-scanning preferences through the settings autosave path.
Successful reauthentication clears only that account's obsolete credential error
and refreshes its quota; a quota outage does not turn a completed login into failure.

Settings → Advanced provides directory overrides, import/export, backups, cloud
synchronization and logging. Regular builds retain the `.cc-switch` storage
identity and configured Codex directory. Preview defaults live below
`~/.codex-switch-preview`; do not import a running profile's credentials or directory
overrides into the preview.

If the database comes from a newer schema, the recovery screen provides the local
configuration folder and exit action. Use a compatible build or restore a suitable
backup; there is no upstream automatic-update fallback.
