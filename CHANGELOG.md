# Changelog

What changed in each JDB release, newest first. JDB shows these notes after it updates, so write them for the people using it. `npm run release` refuses to release a version without a section here.

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
