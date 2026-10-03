# Security

This fork manages account tokens, API keys and local configuration. Do not attach
credentials, database exports, authentication files or real session content to
public reports. Redact logs before sharing them.

Report vulnerabilities privately to this repository's maintainer through its
private reporting channel when available. An upstream project's contact address
is not a support or security channel for this fork. If private reporting is not
available, request a private contact without disclosing the vulnerability details.

Local previews use a separate default profile, but explicit path overrides can
reach other directories. They are not OS sandboxes. Backup/import/export and
cloud synchronization may contain sensitive data; review the destination and
profile before using them.

See [architecture and compatibility](../docs/ARCHITECTURE.md) for authentication,
atomic-write and recovery boundaries, and [LICENSE](../LICENSE) for the license terms.
