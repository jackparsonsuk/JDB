# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

JDB is a desktop database viewer (Electron + React + TypeScript, built with electron-vite) for SQL Server / Azure SQL and MySQL. It is a DBeaver replacement focused on reading data safely; writes are deliberately guarded.

## Commands

```bash
npm run dev          # dev app with renderer hot reload
npm run build        # production build into out/
npm run start        # run the built app
npm run typecheck    # tsc for both node (main/preload/shared) and web (renderer/shared) projects
npm test             # vitest, all tests
npx vitest run src/shared/nl/translate.test.ts             # one file
npx vitest run src/shared/nl/translate.test.ts -t "EXISTS"  # tests matching a name
npm run dist         # Windows NSIS installer into dist/
npm run deploy       # build and copy over the locally installed app, then relaunch it
npm run release      # build and publish a GitHub Release (needs GH_TOKEN); installed apps auto-update from it. See RELEASE.md
npm run icon         # redraw build/icon.ico and resources/icon.png (green "JDB") from scripts/make-icon.cjs
```

There is no linter configured. Tests live next to the code as `*.test.ts` and only cover `src/shared` (pure logic).

Renderer changes hot-reload, but changes under `src/main` or `src/preload` need the Electron app fully restarted.

### Installed app

The user runs an installed copy day to day (per-user NSIS install in `%LOCALAPPDATA%\Programs\JDB`). After finishing a feature or fix they'd want to use, once typecheck and tests pass, run `npm run deploy` (`scripts/deploy-local.mjs`) so the installed app picks it up. It closes a running JDB (gracefully first, so the session saves), mirrors `dist/win-unpacked` over the install while keeping installer-only files (`Uninstall JDB.exe`, `elevate.exe`, `resources/app-update.yml`, without which the install can't auto-update), and relaunches. Say so before running it, since it closes the user's open app. Use `npm run dist` only for a first install. The dev and installed apps share the same userData folder (`%APPDATA%\JDB`), so connections, links, history and the saved session are common to both.

The source is in a private GitHub repo (jackparsonsUK/jdb); installers are published to the public jackparsonsUK/jdb-releases. The installer is public and its bundled JavaScript is readable, so keep company-specific names, servers and data out of code, comments and tests. Colleagues get updates through `electron-updater` (`src/main/updater.ts`): packaged apps check jdb-releases at startup and every 4 hours, download in the background, and install on quit or from the sidebar's "Restart to update". Only release when the user asks, since it ships to everyone. Before releasing, or changing anything in the update or release path (`updater.ts`, `scripts/release.mjs`, `scripts/deploy-local.mjs`, the `publish`/`nsis` settings in `electron-builder.yml`), read [RELEASE.md](RELEASE.md): it has the steps, how to check a release and the problems already hit (direct publishing failing, split drafts, the wizard on "Restart now", deploy dropping `app-update.yml`, the pinned `nsis.guid`). Add any new release problem and its fix there. Each release needs a `## X.Y.Z` section in `CHANGELOG.md`, written for users: the app bundles that file and shows the new entries after an update (`lib/whatsNew.ts`, parsed by `src/shared/changelog.ts`), and it becomes the GitHub release description. When a change is worth telling users about, add it to the top section (start a new one for the next version if the top one is already released).

## Architecture

### Process split

- `src/main`: Node/Electron main process. Owns all database drivers, file storage and credentials.
- `src/preload`: exposes `window.api` (typed in `src/preload/api.d.ts`) via `contextBridge`. The renderer has no Node access.
- `src/renderer`: React UI.
- `src/shared`: pure TypeScript used by both sides and by tests. It must not import Electron or Node APIs. Imported as `@shared/...` (alias in `electron.vite.config.ts` and both tsconfigs).

IPC handlers in `src/main/ipc.ts` return `{ ok, value } | { ok: false, error }` instead of throwing, because Electron mangles thrown errors; `src/preload/index.ts` unwraps them back into exceptions. Adding a call means touching `ipc.ts`, `preload/index.ts` and `preload/api.d.ts`, and usually `main/db/index.ts`.

### Databases (`src/main/db`)

`Driver` (`driver.ts`) is implemented by `mssql.ts` (via `mssql`/tedious, with SQL login, Entra browser sign-in or Entra default credentials) and `mysql.ts` (via `mysql2`). Every new capability needs both implementations. `db/index.ts` caches one driver per connection, drops it on connection errors so the next call reconnects, caches whole-schema reads (`cachedSchema`), and applies the read-only guard.

Dialect details that have caused bugs:
- SQL Server uses `TOP n` and needs `SELECT DISTINCT TOP n`; MySQL uses `LIMIT`.
- SQL Server date literals are written `'YYYYMMDD'`, because `'YYYY-MM-DD'` can be misread on `datetime` under UK date settings.
- SQL Server parameters and literals should match the column type (`N'...'` only for `n*char` columns, `BigInt` for ints) so indexes are used.
- Users on Azure SQL may be unable to see user-defined type names; the schema query falls back to the system type. Likewise default and computed-column definitions come back NULL without VIEW DEFINITION, so the designer marks such defaults `defaultHidden` and refuses changes that would drop them.
- MySQL 8 returns information_schema columns in upper case unless aliased (`c.extra` arrives as `EXTRA`), so alias every column you read.
- `formatType` keeps `datetime2`/`time`/`datetimeoffset` scale when it isn't 7, because the designer's ALTER COLUMN restates the type.

### Safety model

- Read-only connections: `runQuery` in `db/index.ts` rejects SQL where `findWriteKeyword` (`src/shared/sqlGuard.ts`) finds a write. MySQL sessions are also set to `READ ONLY` so the server enforces it. The guard deliberately over-blocks rather than risk missing a write.
- Writable non-local connections confirm writes in the renderer (`QueryView`), except on prod, where a write instead starts a staged transaction (`lib/useTransaction.ts`, `TransactionBar`). Staged transactions live in `db/index.ts` (`beginTransaction` etc.), each on a connection of its own via `Driver.begin()`; runs inside one reject COMMIT/ROLLBACK and, on MySQL, statements that commit implicitly (`sqlGuard.ts`). They are rolled back when the tab closes, the page reloads or the connection drops. Tabs with something to lose register it with `useCloseWarning` (`state.tsx`); closing the tab asks, and closing the window asks too: the renderer reports the warnings to main (`setUnsavedWork`) and blocks `beforeunload`, and main's `will-prevent-unload` handler shows the dialog.
- Table grid edits (`lib/useTableEdits.ts`) are staged by primary key and saved through `applyChanges`, one transaction where every statement must match exactly one row or all is rolled back. Literals are written per column type in `src/shared/edits.ts`. Tables without a primary key, views and read-only connections can't be edited.
- Test databases are often shared, so anything that scans data must be bounded: sampling scans at most `SAMPLE_SCAN_ROWS`, related-row counts are capped, time-limited and skip large unindexed tables (`src/main/explore.ts`), and cross-database key lists are capped at `KEY_LIMIT`. Table exports (`src/main/export.ts`) page through `fetchRows` and stop at `EXPORT_ROW_LIMIT`.

- The table designer (`TableDesigner`, a `design` tab) reads `describeDesign` and builds ALTER scripts in `src/shared/design.ts`: on SQL Server one statement per step run in a transaction by `applyDesign`, on MySQL a single ALTER TABLE (DDL commits implicitly there). DDL clears the schema caches, and the renderer's `schemaChanged` makes open views re-read columns.

### Storage

`src/main/store.ts` keeps `connections.json`, `links.json` and `history.json` in Electron's userData folder. Passwords are encrypted with `safeStorage` (DPAPI) and never sent to the renderer; the renderer only sees `hasPassword`. A fresh install starts with no connections; nothing company-specific (server names, logins) may be hard-coded, because the installer is handed to people outside the team. Connections can sit in a sidebar `folder`, and be shared as a collection file (`src/shared/collection.ts`, `src/main/collections.ts`): no ids or passwords, links kept between exported connections, imports matched to existing connections, and imported prod connections forced read-only.

### Renderer

`state.tsx` holds app-wide state: connections, loaded table lists, cross-database links, and tabs. There are three tab kinds, `table` (`TableView`), `query` (`QueryView`, with the `AskBar`) and `record` (`RecordView`, the explorer). Tabs stay mounted and are hidden when inactive, so their state survives switching. `DataGrid` is a virtualised table shared by the table, query and explorer views.

SQL editor autocompletion: lang-sql completes tables and `alias.column` from the schema namespace; `lib/sqlAssist.ts` adds bare column names from the tables the statement mentions and whole join clauses after `JOIN`, using the Ask engine's `Model` (so inferred keys count). The parsing is in `src/shared/sqlComplete.ts`.

Exports: the save dialog's chosen extension picks the format (xlsx, csv, tsv, json, md, sql). Row formatting lives in `src/shared/rows.ts` so both processes use it; `src/shared/xlsx.ts` writes the workbook XML and `src/main/zip.ts` zips it, with no spreadsheet dependency.

### "Ask" engine (`src/shared/nl`)

A rule-based, offline English-to-SQL translator (no LLM, by design). It is driven only by the connected schema, so nothing is hard-coded to particular tables.

1. `model.ts` builds a `Model` from `describeSchema` output: stemmed words for tables and columns, foreign keys (declared, or inferred from names like `CustomerId` to `Customers.Id` with a single-column PK of a compatible type), child links, a display column per table (`src/shared/display.ts`) and a soft-delete column.
2. `translate.ts` tokenises (`tokens.ts`, dates in `dates.ts` are UK day-first) and walks tokens through an ordered list of handlers (count, limit, sort, negation, `with`/`without`, `for`, parent-column conditions, column conditions, bare dates, bare values). Handler order matters; many bugs were fixed by preferring the longest match.
3. Words like "draft" are matched against real values. `valueSources` lists small category-like columns and lookup tables; the result's `wanted` tells the caller what to load (`useNl` calls `distinctValues`), then the text is translated again.
4. Output is either one SQL statement (`buildSql`) or, when linked tables in another database are involved, a step plan (`federated.ts`). `plan.ts` produces the structure drawn by `QueryDiagram`.

### Cross-database links and queries

Databases on different servers can't join natively, so JDB keeps its own registry of links (`CrossLink` in `src/shared/types.ts`).

- Discovery: `src/shared/links.ts` proposes candidates by name (handling tags like `BusinessCMSId` and audit columns like `CreatedByShopUserId`); `src/main/links.ts` samples values and counts matches on the other side, keeping candidates with at least 50% overlap. Links within one connection are rejected in discovery and in the store.
- Confirmed links drive the grid's jump buttons, the row inspector's "Linked in other databases" section and the record explorer.
- In the Ask engine, `attachRemote` makes linked tables in other databases parents or children in the model (tagged `remote`), and `applyCrossLinks` removes wrong name-based inferences. Remote tables are only loaded for connections already connected this session, to avoid triggering Entra sign-in prompts.
- `buildFederated` splits such queries into `keys` steps (filters on the other database, run first), a `main` step with `{{keys:N}}` placeholders, and `enrich` steps that fetch shown columns by key. `src/renderer/src/lib/federated.ts` runs the steps through the normal read-only query path and merges the results into one grid. Sorting or grouping by a remote column is not supported.

## Working in this repo

- The Ask engine's tests use small synthetic schemas; keep real schema dumps and data out of the repo.
- When changing the Ask engine, check both dialects (the tests cover MySQL and SQL Server output) and that suggestion phrases still round-trip (a test asserts each diagram suggestion's phrase brings in its table).
- Shell heredocs and inline Python on this Windows/Git Bash setup have silently mangled backslashes in regexes (e.g. `\b` becoming a backspace). Prefer the Edit/Write tools for code containing regex escapes.
