# Releasing JDB

Installed copies of JDB update themselves from the public [jdb-releases](https://github.com/jackparsonsUK/jdb-releases) repo. The source stays in the private `jdb` repo. A release goes out to everyone who has JDB installed, so only release something that has been tested.

## Doing a release

1. Make sure `npm run typecheck` and `npm test` pass, and that the change works in the installed app (`npm run deploy`).
2. Bump `version` in `package.json`. The new version must be higher than the latest release, and each version can only be released once.
3. Add a `## X.Y.Z` section to the top of [CHANGELOG.md](CHANGELOG.md) with a `- ` bullet per change. Write for the people using JDB, not for developers: the app shows these notes after it updates, and they become the GitHub release description. The release stops if the section is missing or empty.
4. Commit and push to `main`.
5. Tag the commit and push the tag. GitHub Actions (`.github/workflows/release.yml`) then runs the typecheck and tests and publishes the release:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag must match the version in `package.json`, or the workflow stops before building. Follow it in the repo's **Actions** tab.

   To release from your own machine instead (for example if Actions is down), run `npm run release`. It needs `GH_TOKEN` set locally.

6. Check that the run succeeded (locally it prints `Published vX.Y.Z: <link>`), and that the release on GitHub has all three files:
   - `JDB-Setup-X.Y.Z.exe`
   - `JDB-Setup-X.Y.Z.exe.blockmap`
   - `latest.yml`

The whole run takes a few minutes, most of it building the installer and uploading about 117 MB. On Actions, Windows runners count double against the private repo's 2,000 free minutes a month, so a release costs roughly 15–25 of them.

## What `npm run release` does

1. `node scripts/release.mjs prepare` reads this version's notes from CHANGELOG.md, then creates a **draft** release with them as the description. It stops if the notes are missing, if that version is already published, or if more than one draft for it exists.
2. `electron-vite build` and `electron-builder --win --publish always` build the installer and upload the three files into that draft.
3. `node scripts/release.mjs publish` checks that the draft has all three files, then publishes it and marks it as the latest release. If any file is missing, it leaves the draft unpublished, so nothing reaches users.

## One-time setup

- For Actions: the `jdb` repo needs a secret called `RELEASES_TOKEN` (Settings → Secrets and variables → Actions) holding the token below. When the token is renewed, update the secret too.
- For local releases: `GH_TOKEN` must be set as a user environment variable. Use a GitHub **fine-grained token** that can only access `jdb-releases`, with **Contents: Read and write**. Tokens expire, so a release failing with 401 or 403 usually means it needs renewing.
- `jdb-releases` must have at least one commit (it has a README), or GitHub can't create tags there.

## How installed apps update

- `src/main/updater.ts` checks the latest published release at startup and every 4 hours. The config for this is `resources/app-update.yml` in the install folder, which comes from the `publish` section of `electron-builder.yml`.
- A new version downloads in the background. Thanks to the blockmap, it only fetches the parts of the installer that changed.
- When the download finishes, a toast appears and the sidebar shows **Restart to update**. The update installs silently either when JDB closes or straight away from that button, which also reopens JDB. A silent install takes about 20 seconds, during which JDB is closed.
- To see how an update was launched, look at the installer's command line while it runs, for example `Get-CimInstance Win32_Process -Filter "Name like 'JDB-Setup%'"`. A silent update looks like `JDB-Setup-X.Y.Z.exe --updated /S --force-run`. Downloads are cached in `%LOCALAPPDATA%\jdb-updater`.

## Things that went wrong before (don't undo these)

- **Publishing directly failed.** With `releaseType: release`, GitHub rejected the release ("Published releases must have a valid tag"). v0.5.1 went out published but without `latest.yml`, which broke update checks until a newer release replaced it. Keep `releaseType: draft`, and let `scripts/release.mjs` publish.
- **electron-builder split one version across two drafts.** When no release existed yet, its uploads raced and created two v0.5.2 drafts with the files divided between them. That's why `release.mjs prepare` creates the draft first, so there's only one to upload into.
- **"Restart now" showed the installer wizard.** The installer isn't one-click, so `quitAndInstall()` with its defaults runs the full wizard. It must stay `quitAndInstall(true, true)` (silent, then reopen). Remember that an update is carried out by the version already installed, so a fix to the update process only takes effect from the release *after* it.
- **`npm run deploy` could switch off updates.** It mirrors a `--dir` build over the install, and `--dir` builds have no `app-update.yml`. `scripts/deploy-local.mjs` keeps that file; don't remove it from the list of files it keeps.
- **Existing installs must keep upgrading in place.** `nsis.guid` in `electron-builder.yml` is pinned to the id from JDB's original appId. Changing or removing it makes the next installer see existing installs as a different app.

## Code signing

The installer isn't code-signed, so Windows SmartScreen warns on a first manual install (**More info → Run anyway**). Updates aren't affected. If signing is added later, do it with a certificate that stays the same for every release: electron-updater checks that each update is signed by the same publisher as the installed app.

## Cleaning up

A broken or unwanted release can be deleted on the jdb-releases page. Delete its tag as well if you want to reuse that version number. Otherwise just release a higher version, and installed apps take the newest published release. Drafts are never seen by users.
