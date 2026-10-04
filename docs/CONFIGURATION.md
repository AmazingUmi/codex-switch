# Configuration behavior

## Accounts and connections

Home separates subscription accounts and API Providers. The account section's
Add button signs into ChatGPT; the Provider section's Add button creates an API
connection. Subscription accounts query their own five-hour and weekly quota.
API Providers query API balances using their own credentials. An account cannot
be attached to a Provider.

OAuth accounts switch directly without creating Provider records. Adding an
account only saves its login. The committed current selection is one account,
one API Provider, or disconnected. Legacy account bindings and account-shaped
Provider rows are cleaned up while valid accounts and real API-key connections
are retained. Existing API connection configuration and custom TOML remain
editable.

Removing an API Provider deletes its saved configuration and credentials and
clears its balance state. Removing the active Provider leaves the application
disconnected. Account sign-out/removal clears that account's credentials and
quota state; removing the active account also disconnects. Neither operation
automatically activates another saved connection.

The direct account action currently supports file credential storage. It checks
the configuration that would actually be published before writing. Effective
`cli_auth_credentials_store` values of `keyring`, `auto` or `ephemeral`, and
advanced targets explicitly requesting those modes, are rejected with a reason;
the active selection is preserved. The application does not write the OS keyring
or inject credentials into another client's memory. API-key connections publish
native Codex configuration through the same recoverable write engine.

The pencil edits display name, notes, icon and color on the account itself. These
fields persist in the OAuth account store and survive reauthentication without
altering credentials, quota, identity or the active connection. Expired accounts
remain editable. Reauthentication, default-account selection and removal are
available in the editor. Bulk sign-out is available below the Home account list.
The default-account preference is independent of “Current” and does not activate
an account or bind it to a Provider.

A successful switch updates live configuration through the provider service.
The UI updates “Current” from committed backend state, without optimistic account
labels. Failed switches show their reason. The application writes local config
and credentials; it does not establish that already-running clients have adopted
them. Reopen a client if it continues showing the old account. Codex supports file,
keyring and in-memory credential caching ([official authentication reference](https://learn.chatgpt.com/docs/auth)).

## Direct connections

Codex connects directly to OpenAI with official login or to a provider's native
Responses API. Home → API Providers → Add offers DeepSeek and an OpenAI API
template; subscription accounts have a separate login button. DeepSeek's preset uses
`https://api.deepseek.com`, `wire_api = "responses"` and `deepseek-flash`; enter
the DeepSeek API key before activation. API keys, base URL, default model, custom
TOML and native model catalogs remain editable.

The model catalog produces Codex's `model_catalog_json` for the `/model` menu.
Model identifiers, context windows, modalities and native reasoning levels are
preserved. DeepSeek uses its official catalog profile, with saved per-model
customizations applied when generating the local catalog. See the
[DeepSeek Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Local routing, automatic failover, request overrides and Chat/Anthropic protocol
conversion have been removed. The application starts no local request listener.
Saved connections requiring conversion, proxy-only OAuth or full request URLs
remain editable, with their original protocol and metadata preserved; activation
rejects them with a reason. Their provider protocol is not silently converted. New
connections expose native Responses settings only. Legacy presets retain their
stable `codex-<index>` identities, while the new chooser offers only Official and
DeepSeek presets.

## Retiring historical takeover state

Startup performs a one-way cleanup of historical local takeover state. It first
settles interrupted writes, then restores a compatible saved direct connection
when available and clears owned takeover fields and enable/failover markers.
If no saved connection can run directly, the retired route is not activated.
Saved connection records keep their original protocol and metadata for editing;
changing the startup mode does not make unsupported connections compatible.
Existing takeover backups are archived under the application's local backup
folder. This cleanup never starts a local request listener and provides no switch
back to local routing. It is separate from the optional session-history migration
below.

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

Home → Local usage shows local historical request records and scanned Codex sessions,
filtered by time, connection source and model. Direct request statistics come
from session scanning; the application does not intercept live requests. It does not aggregate other devices
or subscription quota, and estimated cost uses the local pricing table. Scope
and quota explanations open from help icons beside their headings. Account cards show
subscription quota with per-account refresh state. Unknown windows remain unknown;
failed refreshes can show a marked last-success snapshot for up to ten minutes.
Expired credentials immediately clear that snapshot. The usage view also manages refresh
and session-scanning preferences through the settings autosave path.
The configuration icon beside automatic scanning opens the independent Token
source setting (`codexUsageSourceDir`). It selects a Codex root containing
`sessions` and `archived_sessions`, accepts an absolute path or `~/`, and takes
effect without restarting. Empty values restore the default. Preview builds
default to the real user's `~/.codex`; regular builds follow the Codex configuration
directory. Scanning reads source logs without changing them and writes statistics
only to the application's database. Saving this preference does not publish other
unsaved settings or rewrite client configuration. Sync Now remains available in
both automatic and manual modes. Changing the source retains recorded history;
use the separate maintenance action when a full rebuild is intended.

macOS and Windows expose the same tray settings: app icon, quota ring with a
number, or ring only; preferred five-hour/weekly window; neutral or threshold
colors. Windows places its compact number inside the icon and keeps full
percentages, reset times and freshness in the tooltip and Quota details menu.
Its ring palette follows the taskbar theme independently of the app theme.
macOS displays the percentage beside the status-bar ring. Unknown values are
distinct from zero; failed refreshes retain the marked last-success state under
the same cache rules on both platforms.
Successful reauthentication clears only that account's obsolete credential error
and refreshes its quota; a quota outage does not turn a completed login into failure.

Settings → Advanced provides directory overrides, import/export, backups, cloud
synchronization and logging. Regular builds store application data in
`~/.codex-switch`; preview builds use `~/.codex-switch-preview` directly. Pricing
overrides are saved in `model-pricing.json` in that application directory.
Configured Codex directories remain independent. Do not import a running
profile's credentials or directory overrides into the preview.

On first startup, the regular build copies legacy `~/.cc-switch` data into
`~/.codex-switch`; preview copies only its own nested
`~/.codex-switch-preview/.cc-switch` into `~/.codex-switch-preview`. It creates a
SQLite snapshot including committed WAL data, checks database integrity and
keeps a private snapshot under `backups/brand-migration-*/data` before publishing.
The original directory remains available offline. An existing `codex-switch.db`
or `brand-migration.json` skips repeat import; other destination conflicts are
rejected without overwriting them. A failed publication removes only files
published by that attempt and keeps the source and backup.

Internal links in the backup refer to the backup itself. A historical Windows
`HOME/.cc-switch` database can be imported when the real-home database is absent;
device settings, live ownership state and first-write backups still come from
the real home. Preview never uses this fallback source.

An inherited override pointing exactly to the old default is reset to the new
default. A genuinely custom directory keeps its location; the owned database is
copied from `cc-switch.db` to `codex-switch.db`, with a snapshot retained as
`backups/brand-migration-*.db`. Regular builds copy only application directory
preferences from the old bundle identity. Browser preferences migrate only when
visible in the same WebView; no other app's browser or login storage is copied.
Legacy directories, filenames and backup content can remain as offline recovery
sources. Subsequent owned database, log, export and browser preference writes
use Codex Switch names. Historical catalog, SQL and sync readers retain support
for existing formats; new output uses the current names.

Installation packages contain application files; local account data can appear
after installation because this first-start migration reads existing CC Switch
data. Removing a saved connection from the active profile does not erase offline
backups or another application's legacy directory.

The independent Token source is the read-only exception: it can observe real
local sessions while preview account state, configuration writes and statistics
storage remain isolated.

If the database comes from a newer schema, the recovery screen provides the local
configuration folder and exit action. Use a compatible build or restore a suitable
backup; there is no upstream automatic-update fallback.
