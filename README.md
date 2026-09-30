# OverlookDB

Formerly JDB. The installer, install folder and release files keep the JDB name, so existing installs update in place.

A streamlined desktop database viewer for SQL Server / Azure SQL and MySQL, built for reading data safely. Writes are deliberately guarded.

## Install

Download `JDB-Setup-x.y.z.exe` from the [latest release](https://github.com/jackparsonsUK/jdb-releases/releases/latest) and run it. Windows may warn about an unknown publisher because the installer isn't code-signed; choose **More info → Run anyway**.

Once installed, OverlookDB checks for new releases in the background. A new version downloads by itself and installs the next time you close it, or straight away from **Restart to update** in the sidebar.

## Features

- **Tables and queries**: a virtualised grid with filters, sorting, column stats and exports (xlsx, csv, tsv, json, md, sql). The SQL editor completes tables, columns and whole join clauses.
- **Ask**: type a question in plain English ("orders from last week without an invoice") and get SQL. It's rule-based and works offline, driven only by the connected schema.
- **Record explorer**: follow a row through its parents and children, including across databases that can't join each other, through links OverlookDB discovers by sampling values.
- **Editing, carefully**: grid edits are staged and saved in one transaction where each statement must match exactly one row. On production connections, writes run in a staged transaction you commit or roll back.
- **Table designer**: change columns and keys, previewing the ALTER script before it runs.
- **Saved queries and snippets**: keep queries by name and folder, find them from the sidebar or Ctrl+K, and insert snippets by name as you type.
- **Row counts before writes**: on shared connections, an UPDATE, DELETE or INSERT shows how many rows it would touch before it runs.
- **Connections**: SQL logins or Microsoft Entra sign-in, organised in folders, shareable as a collection file (with saved queries) without passwords.

## Safety model

- **Read-only connections**: writes (INSERT/UPDATE/DELETE/DDL/EXEC…) are refused before they reach the server. On MySQL the session is also set to `READ ONLY`, so the server enforces it too.
- **Writable test connections** ask for confirmation before running a write; **production** ones stage writes in a transaction instead.
- Every tab is colour-coded by environment (local, dev, test, prod).
- Passwords are encrypted with Windows DPAPI via Electron `safeStorage` and never reach the UI.

## Develop

```bash
npm install
npm run dev        # hot-reloading dev app
npm run typecheck
npm test           # unit tests (SQL guard, dates, Ask engine, …)
npm run dist       # Windows installer in dist/
```

Electron + React + TypeScript (electron-vite). Drivers run in the main process (`mssql`, `mysql2`); the renderer talks to them only through the typed bridge in `src/preload`.

- `src/main/db`: one `Driver` per database kind, plus the read-only guard and history
- `src/main/store.ts`: connections, links and history in the app's userData folder
- `src/renderer`: UI
- `src/shared`: pure logic used by both sides and by the tests
- `src/shared/nl`: the "Ask" engine

## Releasing

Bump `version` in `package.json`, commit, and run `npm run release`. It publishes the installer to the public [jdb-releases](https://github.com/jackparsonsUK/jdb-releases) repo, which installed copies check for updates. See [RELEASE.md](RELEASE.md) for the setup, checks and known pitfalls.

## Licence

[MIT](LICENSE)
