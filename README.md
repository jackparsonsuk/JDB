# OverlookDB

A desktop database viewer for SQL Server / Azure SQL and MySQL, built for reading data safely. Writes are deliberately guarded. It started as a DBeaver replacement for day-to-day work on shared test and production databases.

Formerly JDB: the exe, install folder and settings folder keep that name, so installs from before the rename keep updating and keep their saved passwords.

## Install

Download `OverlookDB-Setup-x.y.z.exe` from the [latest release](https://github.com/jackparsonsUK/JDB/releases/latest) and run it. It's for Windows 10 and 11. Windows may warn about an unknown publisher because the installer isn't code-signed; choose **More info → Run anyway**.

Once installed, OverlookDB checks for new releases in the background. A new version downloads by itself and installs the next time you close it, or straight away from **Restart to update** in the sidebar or Settings → About & updates.

## Features

**Browsing**
- A fast, virtualised grid with filters, sorting, column stats, striped rows and exports (xlsx, csv, tsv, json, md, sql).
- **Lookups**: a key like `OrderStatusId` shows its label ("Draft") beside it, and the side panel lists every value it can take. Foreign keys work straight away; others can be set up from a column's right-click menu.
- **Record explorer**: follow a row through its parents and children.
- **Cross-database links**: databases on different servers can't join, so OverlookDB finds links between them by sampling values, then jumps across them and runs questions that span them.
- A database tree like DBeaver's, with tables pinned to the top.

**Querying**
- A SQL editor that completes tables, columns and whole join clauses, with a ▶ beside each statement that runs it and says how it went.
- `:name` parameters, which ask for a value (typed to suit the column) before running.
- Errors that point at the line and suggest the nearest real column or table name.
- Ctrl+click a table, procedure or alias to open it; stored procedure source with an outline.
- **Ask**: type a question in plain English ("orders from last week without an invoice") and get SQL. It's rule-based and works offline, driven only by the connected schema.
- Saved queries and snippets, found from the sidebar or Ctrl+K.

**Changing data, carefully**
- Grid edits are staged and saved in one transaction where each statement must match exactly one row.
- After a save or an UPDATE, a Changes view shows each row before → after, read back from the database.
- A table designer that previews the ALTER script before it runs.

**Making it yours**
- Themes (light, dark, dim, midnight, Gruvbox, high contrast), accent and environment colours, fonts and sizes.
- How dates, NULLs and numbers show; what Ctrl+Enter runs; query time limits and row caps.

## Safety model

- **Read-only connections**: writes (INSERT/UPDATE/DELETE/DDL/EXEC…) are refused before they reach the server. On MySQL the session is also set to `READ ONLY`, so the server enforces it too.
- **Shared test and dev connections** say how many rows a write would touch, and ask, before it runs. **Production** ones stage writes in a transaction you commit or roll back.
- Anything that scans data on your behalf (samples, related-row counts, lookups, exports) is bounded and time-limited, because test databases are often shared.
- Every tab is colour-coded by environment (local, dev, test, prod, or your own).
- Passwords are encrypted with Windows DPAPI via Electron `safeStorage` and never reach the UI. Shared connection files never contain them.

## Develop

You need Windows and Node.js 22.

```bash
npm install
npm run dev        # the app, with hot reload for the UI
npm run typecheck
npm test           # unit tests
npm run dist       # a Windows installer in dist/
```

Electron + React + TypeScript (electron-vite). Database drivers run in the main process (`mssql`, `mysql2`); the UI talks to them only through the typed bridge in `src/preload`.

- `src/main/db`: one `Driver` per database kind, the read-only guard, staged transactions and history
- `src/main/store.ts`: connections, links, saved queries and settings in the app's userData folder
- `src/renderer`: the UI
- `src/shared`: pure logic used by both sides, and all the tests
- `src/shared/nl`: the "Ask" engine

[CLAUDE.md](CLAUDE.md) goes deeper into the architecture and the database quirks that have caused bugs. See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change.

## Releasing

Bump `version` in `package.json`, add a `## X.Y.Z` section to [CHANGELOG.md](CHANGELOG.md), merge to `main`, then push a `vX.Y.Z` tag. GitHub Actions builds the installer and publishes it to this repo's releases, which installed copies check for updates. [RELEASE.md](RELEASE.md) has the setup, the checks and the problems already hit.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
