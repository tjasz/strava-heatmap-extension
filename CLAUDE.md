# Release process

## When creating a new version branch `vX.Y.Z.a`

Make this the first commit on the branch, before any other work, so the loaded
extension already shows the version being tested:

1. Match `X.Y.Z` to the version from the main fork that this version branch is based on.
2. Increment `a` if a prior version based on `X.Y.Z` already exists.
3. Bump `"version"` in `manifest.json` to `X.Y.Z.a` (`package.json` stays `0.0.0`).
4. Add an entry at the top of `CHANGELOG.md`, under `## Versions`:
   `` ### `X.Y.Z.a` (YYYY-MM-DD) `` followed by the changes.

Work directly on `vX.Y.Z.a`: don't create extra branches for it.

## When releasing

1. Run `npm test`, and update the `CHANGELOG.md` date to the release day.
2. Build the store zips with `npm run build` (`dist/X.Y.Z-chrome.zip`, `dist/X.Y.Z-firefox.zip`).
3. Fast-forward `master` to `vX.Y.Z.a`, then push `master` and `vX.Y.Z.a`.
4. Never delete version branches: the logged-out fallback image URL points at
   `refs/heads/vX.Y.Z.a` (see `getTileTemplate` in `src/clients/common/layers.js`).
