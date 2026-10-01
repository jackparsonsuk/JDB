# Changelog

What changed in each JDB release, newest first. JDB shows these notes after it updates, so write them for the people using it. `npm run release` refuses to release a version without a section here.

## 1.8.0
- **Hover a table to see its columns.** In the SQL editor and stored procedure source, rest the pointer on a table name or an alias (`o` in `o.Status`) and a card lists the table's columns with their types, keys (PK, FK) and row count, with the column you're on highlighted. Hovering a procedure or function says what it is. Ctrl+click still opens it.

## 1.7.0
- **Labels beside lookup keys.** A column like OrderStatusId now shows its label ("Draft") beside each key, in tables and in query results, while the key itself stays exactly as it was: copying, filtering and editing still use it. Lookup columns widen to fit both. Only the keys on screen are looked up, once each. Turn it off in Settings → Grid & values.
- **The installer says OverlookDB.** The download is now `OverlookDB-Setup-x.y.z.exe`, and the setup wizard, Start menu and desktop shortcuts, and Apps & features all say OverlookDB. Updating renames your existing JDB shortcut rather than adding another, and your connections, passwords and settings carry on as they are. The first update after this may download the full installer once rather than just the changes.
- The interface now uses your operating system's own font by default (Segoe UI on Windows). Settings → Fonts & size calls it **System default**, and Segoe UI Variable is now one of the fonts you can pick.
- **Striped rows.** Alternate rows in tables and query results are lightly shaded, so a wide row is easier to follow across. Turn it off in Settings → Grid & values → Rows.
- **Check for updates in Settings.** Settings → About & updates shows the version you're running, checks for an update on the spot, and offers **Restart to update** once one has downloaded.

## 1.6.0
- **New query for a database or schema.** Each database / schema folder in the sidebar has a ⌨ button that opens a query tab for it ("Query 3 · Support"). After FROM, JOIN, UPDATE or INTO, its tables are suggested first and written in full (`Support.TaskQueue`), so the query runs where you expect.
- **Gruvbox theme.** A warm, retro dark theme in Settings → Theme & colours (or Ctrl+K, "Theme: Gruvbox"), with Gruvbox colours in the SQL editor and routine source too.
- **More in Settings → Grid & values.** Show dates as stored, 2026-06-15, 15/06/2026, 06/15/2026 or 15 Jun 2026, with or without fractions of a second, and optionally in your own time zone. Show NULL as NULL, blank, ∅ or (null). Turn on thousands separators (ID-like columns are left alone). Copying, exporting, filtering and editing still use the stored value.
- **New Settings → SQL editor section.** Choose whether Ctrl+Enter runs the statement at the cursor or everything (like SSMS), hide the ▶ run buttons or the ✓ / ✕ notes, use lower-case keywords in suggestions and formatting, and have suggestions appear only on Ctrl+Space.
- **New Settings → Queries & startup section.** Stop queries after a time limit, keep at most a set number of rows per result, start without reopening the last session's tabs, and pick the connection Ctrl+T uses when no tab is open.
- **Pin tables to the top.** Right-click a table or view in the sidebar and choose **Pin to top**; it moves to a **Pinned** group at the top of that connection's list. Right-click it again to unpin. The same menu can open the table, start a query on it or copy its name.
- **A tighter sidebar filter.** Filtering tables and routines no longer picks letters out of the middle of words, so "next" stops matching `queue_invoice_export`. Any part of a name still matches ("voice"), and so do word starts: "pe" or "proem" finds ProcessedEmails, "qie" finds queue_invoice_export.
- **Easier-to-read SQL before a write.** The SQL shown before saving grid edits or confirming a write is highlighted like the editor and wraps instead of scrolling sideways. When saving grid edits, each statement is laid out on its own lines (UPDATE, SET, WHERE) with a blank line between statements.
- **See what a grid save changed.** After **Review & save** in a table, a panel above the grid shows each edited row's values before → after, shown straight away, then checked against the database in the background (so changes made by triggers or defaults show too), plus how many rows were deleted and added. Close it with ✕.

## 1.5.1
- **Databases as folders.** When a connection shows more than one database (or schema), the sidebar groups them like DBeaver: a folder per database with its Tables and Views inside, and in Routines its procedures, functions and triggers. The connection's own database starts open, and filtering opens every folder with a match.
- Fixed: in results scrolled to the right, the selected row's number could show the cells passing underneath it, so the selected cell looked like it sat over the row numbers.

## 1.5.0
- **More rows per page.** Tables can show 1,000 rows a page, or pick **Custom…** and type your own number (up to 10,000). The size you pick is remembered for the next table you open.
- **New query from the sidebar.** Each connection has a ⌨ button that opens a query tab on it, and right-clicking a connection gives a menu with New query, links, reconnect and edit.
- **Run buttons in the SQL editor.** A green ▶ sits beside the first line of each statement; click it to select and run just that statement.
- The ▶ is amber for a statement that changes data (UPDATE, DELETE, INSERT…), and a 🔒 on a read-only connection, so you can see a write before you run it.
- After a statement runs, a note at the end of it says how it went: ✓ with the row count and time, or ✕ with the error (click it to go to where it failed). Edit the statement and the note goes.
- While a statement runs its ▶ becomes a spinner; click it to stop the query.
- **Lookups in query results.** Click a cell in a query's results and, when the column comes straight from a table column with a lookup (a foreign key, or one you set up), the side panel shows its values and labels, just like in a table tab. It follows `o.Status`, `Status AS s`, `*` and `o.*`; calculated columns don't have one. Right-click a column header to set one up.
- **Shortcuts swapped:** **Ctrl+Enter** now runs the selection, or the statement the cursor is in, and **Ctrl+Shift+Enter** runs everything. F5 and the Run button still run the selection, or everything.
- **Columns first after `alias.`** Typing `o.` in the SQL editor now lists only that table's columns, without keywords like DESC mixed in.

## 1.4.0
- **Query parameters.** Write `:customerId` (or `@customerId`) in a query and running it asks for a value first. Values are written to suit the column they're compared with (quoted for text, as they are for numbers, dates the safe way), and `IN (:ids)` takes a comma-separated list. You can also choose Text, Number, NULL or raw SQL for a value, see the finished SQL before it runs, and each value is remembered for next time. Great for saved queries.
- In scripts that declare their own variables (`DECLARE @x`, `SET @x = …`), `@x` is left alone as the database's variable, and only `:name` asks.
- **Errors point at the SQL.** When a query fails, the line it failed on is highlighted and the bad name is underlined. **Line N** in the error jumps to it.
- For a misspelt column or table, the error suggests the nearest real names ("Did you mean OrderNumber?"), and clicking one fixes it in the editor.
- **Ctrl+click a name to open it.** In the SQL editor and in stored procedure source, hold Ctrl and the table or procedure under the pointer is underlined. Click to open it; Shift+Ctrl+click opens it beside.
- It follows aliases too: Ctrl+click `o` in `o.Status` opens the table `o` stands for, and Ctrl+click `Status` opens that table at the Status column.

## 1.3.0
- **Lookups.** Click a cell in a column like OrderStatusId and the side panel lists the values it can take with their labels ("Draft", "Final", "Insurer"…), with the current one highlighted. Search the list, and with ✎ Edit on, click a value to set the cell.
- Foreign keys work straight away. For a column without one, right-click its header and choose **Look up values in another table…**, then pick the table, its key and the columns to show. It's remembered, and other connections with the same table use it too.
- For a shared lookups table that holds many kinds of lookup, the list shows only the kind the column uses (the same TypeId as its values), with a switch to show them all.
- **The selected cell stands out**, with an outline, and the ← → keys move it along the row.
- **Find a column in the table designer**: a search box filters the columns by name, type, key or comment.

## 1.2.1
- **No more mystery empty connections.** If a connection shows no tables, the sidebar now says which database it's connected to and lists the other databases on the server. Click one to switch the connection to it. On Azure SQL a blank Database means you land in master, which has no tables of its own, and the connection dialog now warns about that before you save.
- **Insert a saved query into the tab you're working in.** Hover a saved query in the sidebar and click ⤵ to drop its SQL in at the cursor, instead of opening it in a new tab.

## 1.2.0
- **See what an UPDATE changed.** After an UPDATE runs, a **Changes** tab lists each row it changed, with the old value crossed out next to the new one. It also says when rows matched but already had those values, or when nothing matched at all, so you can tell on MySQL whether it worked. It works inside transactions too, so you can check staged changes before you commit. It needs a table with a primary key and doesn't cover joined updates.
- **Query tabs open as plain SQL**, with the editor ready to type in. ✦ Ask is still one click away on the toolbar.
- **Right-click in the SQL editor** to run the selection, the statement under the cursor or everything, plus cut, copy, paste, toggle comment, format and save.
- **Ctrl+Shift+Enter** runs the statement the cursor is in, and **Shift+Alt+F** formats the SQL (Ctrl+Z undoes it).
- **Long lines wrap** in the SQL editor by default, so a long pasted WHERE clause stays on screen. You can switch this off in Settings → Grid & editor.

## 1.1.0
- **Settings** (Ctrl+, or the ⚙ in the sidebar) to make OverlookDB your own. Changes show straight away.
- New themes: **Dim** (a softer dark), **Midnight** (near-black) and **High contrast**, alongside Light, Dark and following Windows.
- Pick an **accent colour** from the swatches or any colour you like, and change the **environment colours** used for local, dev, test and prod.
- Choose the **interface font**, the **code font** and its size (with ligatures for fonts that have them), and scale the whole interface from 90% to 125%.
- **Row density** for tables and results (compact, comfortable or spacious), and word wrap and indent size in the SQL editor.
- **Your own environments**, like UAT, Staging or Demo, alongside local, dev, test and prod. Give each a colour and a safety level: **Relaxed** (writes just run), **Confirm** (writes ask first, with a row count) or **Protected** (writes go in a transaction you commit, like prod). Add them in Settings → Environments, then pick them for a connection.
- Environments travel with shared connection files. A shared file can add new ones but never make yours less careful, and anything protected still arrives read-only.

## 1.0.0
- **JDB is now OverlookDB**, with a new logo: an O with the sun rising over the horizon. Everything else stays where it was: your connections, saved passwords, links and settings carry over, and updates keep arriving as before.
- **Saved queries.** Press **Ctrl+S** in a query tab to keep a query by name, in a folder if you like. Open it again from **Saved queries** at the bottom of the sidebar or from Ctrl+K. After that Ctrl+S saves changes to it, and a dot on the tab shows when there are some.
- **Snippets.** Save a query for **Any connection** and it works everywhere: start typing its name in any query and pick it from the suggestions to drop its SQL in.
- Saved queries travel with shared connection files: exporting all connections includes them, and exporting a folder includes the queries for its connections.
- **See how many rows a write will change before it runs.** On shared connections, running an UPDATE, DELETE or INSERT now shows how many rows it would touch, for example "12 rows to update in dbo.Orders", and warns in red when there's no WHERE clause. Cancel is the default, so Enter never runs it by accident.
- Questions like "Delete this connection?" or "Close this tab?" now appear in JDB's own style instead of the plain Windows box, with the choice spelled out on the buttons. Anything that deletes or discards starts on Cancel.

## 0.5.10
- Choosing **What's new** (or any command that opens a window) in Ctrl+K with Enter no longer closes it again straight away.
- Release notes show button and menu names in bold, and the Close button stays in view while you scroll them.
- A tidier table filter bar. Number and date columns start on **=** and text columns on **contains**, the column list shows each column's type, and Apply waits until there's a value. Click a filter chip to change it instead of removing and re-adding it.
- Opening a routine from a source search finds the match in the formatted view too, even when the search spans several words.
- Source search says when there are more matches than it shows, instead of stopping at 200 without a word.
- On MySQL, "changed 3 hours ago" for routines is right even when the server's clock is in another time zone.
- Escape closes the release notes without clicking into them first.
- Ctrl+K finds the tables of any connection you have a tab open on, without expanding it in the sidebar first.
- A MySQL handler (DECLARE ... HANDLER) shows in a routine's outline as control flow, not as an error.
- Long routine names no longer make the sidebar scroll sideways, and when a routine's source is hidden only the Overview tab looks selected.

## 0.5.9
- Stored procedures are much easier to read. **Formatted** lays the source out with one statement per line, indented blocks and IF / ELSE bodies, and long lists and conditions split over lines. Only spacing and keyword capitals change; switch to **As written** to see the original.
- An **Outline** beside the source maps the routine: each IF, ELSE, loop and TRY / CATCH, every statement with the table it touches, and comment headings. Click one to jump to it. **Changes** narrows it to the lines that write, call other routines, raise errors or handle transactions.
- Lines that write to a table, call another routine or control a transaction are marked in the margin, so you can see at a glance what a procedure changes.

## 0.5.8
- Stored procedures, functions and triggers. Switch a connection in the sidebar to **Routines** to browse them, and open one to read its source with its parameters and the tables it reads and writes. "Script call" writes a ready-to-fill EXEC for it.
- Search inside routine source: click **{ }** next to the routines filter to find every procedure or trigger that mentions a table, column or any text. Routines also show up in Ctrl+K.

## 0.5.7
- After an update, JDB tells you what's new. You can also open the notes any time from the command palette (Ctrl+K → "What's new").

## 0.5.6
- Check for updates from the command palette (Ctrl+K → "Check for updates").

## 0.5.4
- "Restart to update" installs silently and reopens JDB, instead of showing the installer.

## 0.5.0
- JDB updates itself. New versions download in the background and install when you close JDB, or straight away from "Restart to update" in the sidebar.

## 0.4.2
- A fresh install starts with no connections.

## 0.4.1
- The sidebar can be resized.
- Closing a tab or the window warns you if it would lose unsaved edits or an open transaction.

## 0.4.0
- Edit table data in the grid. Changes are staged and saved in one transaction. Tables need a primary key to be edited.
- Writes on production connections run in a staged transaction you commit or roll back.
- A table designer for changing columns and keys, showing the script before it runs.

## 0.3.0
- The SQL editor completes column names.
- Export tables and query results to a file.
