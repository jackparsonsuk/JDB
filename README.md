# JDB

A streamlined desktop database viewer for SQL Server / Azure SQL and MySQL.

## Run

```bash
npm install
npm run dev        # hot-reloading dev app
npm run typecheck
npm test           # unit tests (SQL guard, date parsing, Ask engine)
npm run dist       # Windows installer in dist/
```

## Stack

Electron + React + TypeScript (electron-vite). Drivers run in the main process (`mssql`, `mysql2`);
the renderer talks to them only through the typed bridge in `src/preload`.

- `src/main/db` — one `Driver` per database kind, plus the read-only guard and history
- `src/main/store.ts` — connections and query history in the app's userData folder; passwords encrypted with Windows DPAPI via Electron `safeStorage`
- `src/renderer` — UI
- `src/shared` — types and the SQL write-detection used by both sides
- `src/shared/nl` — the rule-based "Ask" engine: turns plain English into SQL using only the connected schema

## Safety model

- **Read-only connections**: writes (INSERT/UPDATE/DELETE/DDL/EXEC…) are refused before they reach the server. On MySQL the session is also set to `READ ONLY`, so the server enforces it too.
- **Writable test/prod connections** ask for confirmation before running a write.
- Every tab is colour-coded by environment (local, dev, test, prod).
