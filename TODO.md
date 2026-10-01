# TODO

What could come next for OverlookDB, roughly in the order worth doing. Tick things off or move them into CHANGELOG.md as they ship. New work goes on a feature branch; see CLAUDE.md.

## From using it

- [x] **Show what an update changed.** After an UPDATE (from a query or grid edits), show the rows it touched with before and after values, so it's clear it worked. It's especially hard to tell on MySQL today, which only reports "rows affected". (1.2.0)
- [x] **Show what grid edits changed.** After a grid save, a panel above the grid shows the edited rows before → after, read back by key, with deleted and added counts. (1.6.0)
- [x] **Query tabs open as plain SQL.** A new query tab should start with the SQL editor focused and the Ask bar closed; Ask stays one click away (✦ Ask). (1.2.0)
- [x] **Right-click menu in the SQL editor.** Run selection, run all, run the statement under the cursor, format, copy, save as a query. (1.2.0)
- [x] **Word wrap on by default in the SQL editor.** A long pasted WHERE clause (dozens of `AND` conditions) currently runs off to the right. Turn wrapping on unless the user switches it off in Settings → Grid & editor. (1.2.0)
- [x] **Explain empty connections.** A connection with no tables says which database it's in and offers the others; the dialog warns about a blank Database on Azure SQL. (1.2.1)
- [x] **Lookups in the table view**, a clearer selected cell, and column search in the designer. (1.3.0)
- [x] **Query parameters**, **errors that point at the SQL**, and **Ctrl+click names to open them**. (1.4.0)
- [x] **More rows per page**: 1,000 a page, or a custom size up to 10,000. (1.5.0)
- [x] **New query from the sidebar**: a ⌨ button and a right-click menu on each connection. (1.5.0)
- [x] **Only columns after `alias.`** in autocompletion, no keywords. (1.5.0)
- [x] **Run gutter**: a ▶ per statement, amber for writes, 🔒 on read-only, a spinner that stops the run, and a ✓ / ✕ note with rows and time. (1.5.0)
- [x] **Ctrl+Enter runs the statement at the cursor**, Ctrl+Shift+Enter runs everything. (1.5.0)
- [x] **Lookups in query results**, for columns read straight from a table column. (1.5.0)
- [x] **Databases as folders** in the sidebar when a connection spans several, like DBeaver. (1.5.1)
- [x] Fixed: the connection dialog's Folder box sat below Environment (1.5.0), and the selected row's number showed cells through it when scrolled right (1.5.1).

## Check first (built but not yet seen for real)

- [ ] **Watching a row.** Watch a row on local MySQL while changing it from the app under test; check changes, a delete and a re-insert show, and that a dropped connection stops the watch after three failed reads. Next steps if it proves useful: also watch the record's child rows (inserts, updates, deletes in related tables), and a MySQL binlog mode that catches every change rather than polling.

- [ ] **Row-count confirm dialog on a writable test connection.** It only appears on writable, non-local, non-protected connections, so it hasn't been opened against a real server yet. Try an UPDATE with a WHERE, one without, a joined DELETE and an INSERT ... SELECT.
- [ ] **Proc formatter on real SQL Server procs.** The layout guesses T-SQL structure without semicolons. Open some long procs and note any odd layout or a "shown as written" fallback.
- [ ] **Custom environments through a shared file.** Export a connection on a custom environment, import it on another machine, and check the environment arrives and a protected one comes in read-only.
- [ ] **The Changes view on both dialects**, including inside a staged transaction on prod (before commit) and an UPDATE whose SET changes a WHERE column.
- [ ] **Lookups on Shop's shared `lookups` table.** Check the TypeId narrowing picks the right kinds, and how a foreign key to a big table behaves (it should search, not list).
- [ ] **Error lines on MySQL multi-statement scripts.** It isn't confirmed whether MySQL's "at line N" counts from the whole script or from the failing statement; the spot is found by text first, so only the line may be off.
- [ ] **Azure database picker** on a connection with a blank Database (it should land in master and list ProdDB and the rest).
- [ ] **Run gutter in use** (1.5.0): markers on the left of the line numbers, the spinner stopping a slow query, notes clearing when a statement is edited, and the ✕ note jumping to the error.
- [ ] **Lookups in query results** (1.5.0): `SELECT *` with joins, `alias.*`, `AS` names, and a script with several SELECTs.
- [ ] **Lookup labels** (1.7.0): GUID and int keys on both dialects, a shared lookups table with TypeId narrowing, a page of 10,000 rows, an edited cell picking up its new label, and a lookup whose label columns are empty.
- [ ] **Settings** (1.6.0): each date format on both dialects, local time across a BST change, the time limit on a slow query (the message, and the gutter note), the row cap on a big SELECT *, and Ctrl+Enter swapped back.
- [ ] **Grid save changes** (1.6.0): edits, a delete and an add in one save, a table with a trigger, and over 200 edited rows (only the first are compared).
- [ ] **Database folders** (1.5.1) on a MySQL connection with a blank Database, and on a SQL Server database with several schemas, including the filter and the Routines switch.

## Features

- [x] **Clickable names in routine source.** Ctrl+click a table or proc name in the code to open it, in routine source and the SQL editor. (1.4.0)
- [x] **Hover a table to see its columns**, in routine source and the SQL editor, from `nameAt` (`lib/clickableNames.ts`). (1.8.0)
- [x] **Labels in the grid for lookup columns**, beside the key (which is unchanged), in tables and query results; `lib/lookupLabels.ts`. (1.7.0)
- [ ] **Share lookups in connection files**, like links and saved queries.
- [ ] **Search every table for a value.** Paste a GUID or email and see which tables and columns hold it, reading only indexed or likely columns, bounded and time-limited.
- [ ] **Dry run on prod.** Run a write in a transaction, show the Changes view, then roll back automatically.
- [ ] **Undo last change.** After an UPDATE or grid save, offer a script that puts the rows back, from the Changes view's before values.
- [ ] **Diff between connections.** Compare a table's columns and keys between two connections, one row by key, or a query's results on both. Link discovery already does much of the sampling.
- [ ] **Query plans.** An Explain button on query tabs (SHOWPLAN_XML on SQL Server, EXPLAIN FORMAT=JSON on MySQL) that flags table scans on big tables.
- [x] **Pinned tables** per connection, at the top of its table list, from a right-click menu. (1.6.0)
- [ ] **Recent tables** per connection, beside the pinned ones.
- [ ] **Share a result** as a Markdown table or a Teams / Slack message, with the query and connection name.
- [ ] **ER diagram from the Ask model.** A "tables around this one" diagram, including inferred keys and cross-database links.
- [ ] **Pinned records.** Pin a record in the explorer and come back to it later, across databases.
- [ ] **Explain this SQL.** Turn a query into a plain-English summary using the Ask engine's model.
- [ ] **Quick charts.** A bar or line chart of a grouped query result, drawn as SVG.
- [x] **Filter from a cell.** Right-click a cell and choose "filter to this value" or "exclude it", added as a filter chip.
- [x] **Insert a saved query into the open tab** from the sidebar, rather than only opening it in a new tab. (1.2.1)
- [x] **More settings**: date, NULL and number display, Ctrl+Enter, keyword case, the run gutter and notes, autocompletion, a query time limit, a row cap, starting fresh, and Ctrl+T's default connection. (1.6.0)
- [ ] **Import and export appearance settings**, so a theme and colours can be shared.
- [ ] **More from the run gutter**: right-click a ▶ for Count rows first, Explain, Run in a new tab and Copy; Shift+click to run from there down; one result tab per statement when running several.
- [ ] **Database folders, the rest of DBeaver's tree**: empty databases, Indexes and Events folders, and routines under each database in one tree rather than the Tables / Routines switch.
- [ ] **Lookups for procedure results** and batches whose result sets don't pair up with their SELECTs.

## Smaller improvements

- [ ] The table toolbar wraps to a second row when filters are applied; tighten it.
- [x] The sidebar's name filter only jumps to word starts (`wordScore` in `src/shared/fuzzy.ts`), so "next" no longer matches `queue_invoice_export`. (1.6.0) The command palette, column finder and saved queries still use the looser `lib/fuzzy.ts`.
- [ ] `DECLARE ... CURSOR FOR` then `SELECT` could indent the SELECT one level in the formatter.
- [ ] MySQL `PREPARE` and `EXECUTE` show in the outline as a call; label them as prepared statements.
- [ ] Deploy (`scripts/deploy-local.mjs`) force-closes the app when it's asking about unsaved work, which discards it. Ask before forcing, or stop and say so.
- [ ] Read-only connections block `SELECT ... INTO @var` (MySQL) and `EXEC sp_helptext`. That's deliberate over-blocking; revisit only with a safe allow-list.
- [ ] The Changes view skips joined UPDATEs and SQL Server's `UPDATE ... FROM`; they could be read back through the target's key when the join is on it.

## Housekeeping

- [ ] Once most people are on 1.7.0 or later, drop the `jdb-releases` entry from `publish` in `electron-builder.yml` and the token's access to it. Keep the jdb-releases repo and its 1.7.0 release up for anyone still on an older version (RELEASE.md, Moving off jdb-releases).

- [ ] Tests only cover `src/shared`. Consider a small scripted smoke test of the installed app (the debug-port approach used during testing) for the main flows.
- [ ] RELEASE.md: note that GitHub CLI isn't installed on this machine, and releases are checked through the public releases API instead.
- [ ] Delete merged branches (`fixes/minor`, `feature/saved-queries`, `feature/customisation`, `feature/query-params-errors`, `feature/clickable-names`, `feature/1.5.0`, `fix/rownum-see-through`, `feature/database-tree`, `feature/grid-edit-changes`) once nothing else is needed from them.
