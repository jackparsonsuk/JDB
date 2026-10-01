# Security

OverlookDB connects to databases with saved credentials, so security problems matter. Please don't report them in a public issue.

## Reporting a vulnerability

Use **Report a vulnerability** on this repo's [Security tab](https://github.com/jackparsonsUK/JDB/security). That reaches the maintainer privately. Say what's affected, how to reproduce it, and which version you're on (Settings → About & updates).

You'll get a reply as soon as possible, and a fix goes out as a normal release, which installed copies pick up automatically.

## Supported versions

Only the latest release gets fixes. Installed copies update themselves, so that's what almost everyone runs.

## Worth knowing

- Saved passwords are encrypted with Windows DPAPI (Electron `safeStorage`), tied to the Windows user, and never sent to the UI.
- Shared connection files never include passwords.
- The installer isn't code-signed yet.
