# Changelog

What changed in each JDB release, newest first. JDB shows these notes after it updates, so write them for the people using it. `npm run release` refuses to release a version without a section here.

## 0.6.0
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
