# Releasing

## @spyglassjs/ui (npm)

1. Bump `version` in `ui/package.json` in a PR and merge it.
2. Tag the merge commit and push the tag:
   ```sh
   git tag ui-v0.1.1 && git push origin ui-v0.1.1
   ```
3. `.github/workflows/release-ui.yml` checks the tag matches the package version,
   builds, tests and publishes with provenance. It needs the `NPM_TOKEN` repo secret
   (an npm granular token with publish rights on `@spyglassjs/ui`).

Always publish with `pnpm`, never `npm publish`. The repo's `exports` map has a
`development` condition pointing at `src/` so studio and Storybook get HMR; pnpm swaps
in `publishConfig.exports` at pack time so the tarball only references `dist/`.
Check with `cd ui && pnpm pack && tar tzf spyglassjs-ui-*.tgz`.

## spyglass (Rust crate)

The crate isn't on crates.io. Consumers pin a git tag:

```toml
spyglass = { git = "https://github.com/spyglass-dev/spyglass", tag = "v0.1.0", default-features = false, features = ["postgres"] }
```

Bump `version` in `Cargo.toml`, merge, then `git tag v<version> && git push origin v<version>`.
