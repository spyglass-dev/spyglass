# Releasing

## @spyglassjs/ui (npm)

1. Bump `version` in `ui/package.json` in a PR and merge it.
2. Tag the merge commit and push the tag:
   ```sh
   git tag ui-v0.1.1 && git push origin ui-v0.1.1
   ```
3. `.github/workflows/release-ui.yml` checks the tag matches the package version,
   builds, tests, packs with pnpm and publishes with npm and provenance. If that
   version is already on npm, it skips instead of failing.

   Auth is npm **trusted publishing**: npm trusts `release-ui.yml` in this repo
   through GitHub's OIDC token, so there is no `NPM_TOKEN` secret. The trust is
   set under npmjs.com → `@spyglassjs/ui` → Settings → Trusted publishing
   (owner `spyglass-dev`, repo `spyglass`, workflow `release-ui.yml`). Renaming
   the workflow file breaks it until the trust is updated. 0.2.1 was the first
   release published this way.

   To rerun a release, use **Run workflow** on the Actions tab (`workflow_dispatch`)
   or delete and re-push the tag.

Always **pack** with `pnpm`, never a bare `npm publish` from `ui/`. The repo's `exports` map has a
`development` condition pointing at `src/` so studio and Storybook get HMR; pnpm swaps
in `publishConfig.exports` at pack time so the tarball only references `dist/`.
Check with `cd ui && pnpm pack && tar tzf spyglassjs-ui-*.tgz`.

## spyglass (Rust crate)

The crate isn't on crates.io. Consumers pin a git tag:

```toml
spyglass = { git = "https://github.com/spyglass-dev/spyglass", tag = "v0.1.0", default-features = false, features = ["postgres"] }
```

Bump `version` in `Cargo.toml`, merge, then `git tag v<version> && git push origin v<version>`.
