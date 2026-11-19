# Security policy

This independent fork retains upstream's AGPL license and attribution. Upstream
compliance claims do not apply to this fork or to a self-hosted deployment.

The initial import has unresolved inherited dependency advisories. See
[security status](docs/supamac/security-status.md). Do not treat the existence of
CI configuration as evidence of a clean scan or a verified deployment.

Report vulnerabilities privately through this repository's GitHub Security
advisory reporting when enabled; never put credentials or private workspace data
in a public issue. Revoke exposed credentials at their provider. Removing a
local file or a saved agent key does not revoke the provider credential.

Production deployments must enforce authentication, workspace authorization,
private infrastructure networks, encrypted secrets, isolated agent execution,
bounded retries and resource use, and tested backups. Development test secrets
and emulator endpoints are unsuitable for internet-facing use.
