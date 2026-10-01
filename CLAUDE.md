# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OverlookDB (formerly JDB) is a desktop database viewer (Electron + React + TypeScript, built with electron-vite) for SQL Server / Azure SQL and MySQL. It is a DBeaver replacement focused on reading data safely; writes are deliberately guarded.

The name people see comes from `APP_NAME` in `src/shared/brand.ts`, and the logo from `components/Logo.tsx` (in the app) and `scripts/make-icon.cjs` (the icon), which draw the same shapes. Everything else keeps the JDB name on purpose: the installer and exe, `productName`, app id and pinned `nsis.guid`, the install folder and `%APPDATA%\JDB` userData (which holds the key that decrypts saved passwords), the jdb-releases repo, the `jdb-connections` file format and `.jdb.json` extension, and `jdb.*` localStorage keys. Renaming any of those breaks upgrades, passwords or shared files.

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
npm run icon         # redraw build/icon.ico and resources/icon.png (the OverlookDB mark) from scripts/make-icon.cjs
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

- Environments (`src/shared/environments.ts`) carry the write safety: relaxed (local), confirm (dev, test) or protected (prod), plus any the user adds in `environments.json` with a level of their choosing. Code asks `safety(conn)` from the app state rather than comparing names; an undefined environment is treated as protected. The four built-ins can't be renamed or have their safety changed. Shared connection files carry the custom environments their connections use, and an import never loosens one already defined (`mergeEnvironments`); protected ones arrive read-only.
- Read-only connections: `runQuery` in `db/index.ts` rejects SQL where `findWriteKeyword` (`src/shared/sqlGuard.ts`) finds a write. MySQL sessions are also set to `READ ONLY` so the server enforces it. The guard deliberately over-blocks rather than risk missing a write.
- Writable non-local connections confirm writes in the renderer (`QueryView` → `WriteConfirmDialog`), which first counts the rows the write would touch: `src/shared/writePreview.ts` turns a single UPDATE / DELETE / INSERT into a SELECT COUNT(*) from its own FROM / WHERE (or counts VALUES rows), and main's `countForWrite` refuses anything with a write keyword, stops after 10 s and stays out of history. Batches, MERGE, TOP / LIMIT / OUTPUT and the like say why they can't be counted rather than guessing. The exception is prod, where a write instead starts a staged transaction (`lib/useTransaction.ts`, `TransactionBar`). Staged transactions live in `db/index.ts` (`beginTransaction` etc.), each on a connection of its own via `Driver.begin()`; runs inside one reject COMMIT/ROLLBACK and, on MySQL, statements that commit implicitly (`sqlGuard.ts`). They are rolled back when the tab closes, the page reloads or the connection drops. Tabs with something to lose register it with `useCloseWarning` (`state.tsx`); closing the tab asks, and closing the window asks too: the renderer reports the warnings to main (`setUnsavedWork`) and blocks `beforeunload`, and main's `will-prevent-unload` handler shows the dialog.
- After an UPDATE, a query tab shows what it changed (`UpdateChangesView`): `src/shared/writeDiff.ts` turns a single-table UPDATE into a bounded SELECT of its rows (`DIFF_ROW_LIMIT`), `lib/updateChanges.ts` reads them before it runs and again by primary key afterwards, inside the staged transaction when there is one. Joined updates, several tables and tables without a primary key say why they can't be shown. These reads, and lookup lists, go through main's `snapshotRows`: like `countForWrite` it refuses write keywords, stops after 10 s and stays out of history. Use it for any read the app makes on the user's behalf.
- Table grid edits (`lib/useTableEdits.ts`) are staged by primary key and saved through `applyChanges`, one transaction where every statement must match exactly one row or all is rolled back. Literals are written per column type in `src/shared/edits.ts`. Tables without a primary key, views and read-only connections can't be edited.
- Test databases are often shared, so anything that scans data must be bounded: sampling scans at most `SAMPLE_SCAN_ROWS`, related-row counts are capped, time-limited and skip large unindexed tables (`src/main/explore.ts`), and cross-database key lists are capped at `KEY_LIMIT`. Table exports (`src/main/export.ts`) page through `fetchRows` and stop at `EXPORT_ROW_LIMIT`.

- The table designer (`TableDesigner`, a `design` tab) reads `describeDesign` and builds ALTER scripts in `src/shared/design.ts`: on SQL Server one statement per step run in a transaction by `applyDesign`, on MySQL a single ALTER TABLE (DDL commits implicitly there). DDL clears the schema caches, and the renderer's `schemaChanged` makes open views re-read columns.

### Storage

`src/main/store.ts` keeps `connections.json`, `links.json`, `history.json`, `queries.json` (saved queries: tied to a connection, or for any connection as snippets, which `lib/snippets.ts` offers in editor autocompletion) and `lookups.json` (lookups set up by hand, below) in Electron's userData folder. Passwords are encrypted with `safeStorage` (DPAPI) and never sent to the renderer; the renderer only sees `hasPassword`. A fresh install starts with no connections; nothing company-specific (server names, logins) may be hard-coded, because the installer is handed to people outside the team. Connections can sit in a sidebar `folder`, and be shared as a collection file (`src/shared/collection.ts`, `src/main/collections.ts`): no ids or passwords, links kept between exported connections, saved queries carried with them (all of them on a full export, a folder's connections' ones otherwise; imports skip exact duplicates), imports matched to existing connections, and imported prod connections forced read-only.

### Renderer

`state.tsx` holds app-wide state: connections, loaded table lists, cross-database links, and tabs. There are three tab kinds, `table` (`TableView`), `query` (`QueryView`, with the `AskBar`) and `record` (`RecordView`, the explorer). Tabs stay mounted and are hidden when inactive, so their state survives switching. `DataGrid` is a virtualised table shared by the table, query and explorer views.

Appearance: the theme (`lib/theme.ts`, `data-theme` on <html>; dim, midnight and contrast are dark variants in `styles.css`, and Windows is told "dark" for them via `nativeThemeOf`) and everything else in Settings (`components/SettingsDialog.tsx`) live in `settings.json`. `src/shared/appearance.ts` checks stored values (`parseAppearance`, which also keeps font names from breaking out of CSS) and turns them into CSS custom properties that override the stylesheet's defaults (`appearanceVars`); `lib/appearance.ts` applies them, zooms the window for the interface size, and saves shortly after the last change. The grid's row height follows the density (`useRowHeight`; changing it re-creates the grid).

Query tabs (`QueryView`): new tabs open as plain SQL with Ask closed. Every way of running (Ctrl+Enter on the selection or the statement at the cursor, Ctrl+Shift+Enter for everything, F5 and the Run button for the selection or everything, the gutter's ▶ per statement (`lib/runGutter.ts`), the right-click `EditorMenu`) goes through `runSql`, which asks for parameters and passes `execute` an `Origin` (the SQL as written and its offset in the editor). Word wrap is on unless Settings stores `wordWrap: false`.
- Parameters (`src/shared/params.ts`, `ParamDialog`): `:name` always, `@name` only in scripts without variables of their own (DECLARE / EXEC / routine definitions on SQL Server; `SET @`, `:=`, `INTO @` on MySQL). Values are written with `columnLiteral` for the column they're compared with, so the dialect literal rules above still hold; last values are kept in localStorage (`jdb.queryParams`).
- Errors (`src/shared/sqlErrors.ts`, `lib/errorMark.ts`): SQL Server errors carry `sqlLine`, the server's line counted from the top of the script across GO batches (set in `mssql.ts` `runBatches`, passed through the IPC envelope and preload). MySQL's line comes from "near '…' at line N". `explainError` finds the unknown column or table, or the syntax error's token, in the SQL as written, and suggests the nearest real names; the editor marks the spot and the error bar can apply a suggestion.
- Ctrl+click (`lib/clickableNames.ts`, in query and routine editors): `nameAt` in `src/shared/routines.ts` resolves the name chain under the pointer to a table (at a column, for `alias.column`), a routine or an alias's table, using offsets the routine tokenizer keeps.

Table tabs: the clicked cell is outlined and Left / Right move it. When its column is a lookup, the side panel is `LookupPanel` rather than the row inspector. A lookup is a declared foreign key, or a `LookupLink` (`src/shared/lookups.ts`) set up from the column header's right-click menu (`LookupDialog`) and reused by other connections with the same table. Shared lookup tables are narrowed to the kinds (`narrowBy`, e.g. TypeId) the column's own values use, from a bounded sample, and tables over `LOOKUP_LIST_MAX_ROWS` are only searched, unsorted, never listed. A connection with no tables shows which database it's in and offers the others on the server (`Driver.listDatabases`); on Azure SQL a blank Database lands in master.

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

- New features and fixes go on a `feature/...` (or `fix/...`) branch off `main`, pushed to GitHub; pushing a branch is safe because the release workflow only runs on `v*` tags. Merge, bump the version and tag only when the user asks to release: each release reaches every colleague, and the user wants time to use changes first.
- `TODO.md` is the working list of ideas and fixes. Tick items off as they're done and add new ones that come up.

- The Ask engine's tests use small synthetic schemas; keep real schema dumps and data out of the repo.
- When changing the Ask engine, check both dialects (the tests cover MySQL and SQL Server output) and that suggestion phrases still round-trip (a test asserts each diagram suggestion's phrase brings in its table).
- Shell heredocs and inline Python on this Windows/Git Bash setup have silently mangled backslashes in regexes (e.g. `\b` becoming a backspace). Prefer the Edit/Write tools for code containing regex escapes.
