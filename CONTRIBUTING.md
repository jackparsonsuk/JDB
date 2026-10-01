# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Getting started

You need Windows and Node.js 22.

```bash
npm install
npm run dev
```

Changes to the UI (`src/renderer`) reload as you save; changes to `src/main` or `src/preload` need the app restarting.

## Before sending a pull request

- `npm run typecheck` and `npm test` pass. The same checks run on every pull request.
- New logic goes in `src/shared` where it can, with tests next to it (`*.test.ts`). Tests there are pure TypeScript and don't need a database.
- Anything that changes the database works on both SQL Server and MySQL. [CLAUDE.md](CLAUDE.md) lists the dialect differences that have caused bugs.
- Anything that reads data on the user's behalf stays bounded and time-limited, and nothing writes without the user asking. See the safety model in [CLAUDE.md](CLAUDE.md).
- A change users would notice gets a line at the top of [CHANGELOG.md](CHANGELOG.md), written for the people using the app.

## Keep it generic

Everything in this repo is public. Don't include real server names, database or table names from a real system, logins, or data, in code, tests, docs or commit messages. Tests use small made-up schemas.

## Releases

Releases are made by the maintainer; see [RELEASE.md](RELEASE.md).
