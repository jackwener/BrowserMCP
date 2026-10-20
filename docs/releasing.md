# Releasing BrowserMCP

The npm package and Chrome extension have separate versions. Each npm release also attaches the current key-bearing extension build as a manual-install zip to GitHub Releases. Update the Chrome Web Store extension separately when extension code changes.

## One-time npm setup

In the [browsermcp npm package settings](https://www.npmjs.com/package/@jackwener/browsermcp), add a **Trusted Publisher** for GitHub Actions:

- GitHub owner: `jackwener`
- Repository: `browsermcp`
- Workflow filename: `release.yml`
- Environment: leave blank

The workflow uses GitHub OIDC to publish to npm. It does not need an `NPM_TOKEN` secret. GitHub Actions must be enabled for this repository.

The rename creates a new npm package, `@jackwener/browsermcp`. Before the first release, establish ownership and configure its Trusted Publisher; the old package's publisher configuration does not carry over. Upload **BrowserMCP Connector** as an update to the existing Web Store item, preserving its extension ID and incrementing the extension version.

## Each release

1. Commit and push the changes you want to release to `main`.
2. Open [Actions → Release npm package and manual extension](https://github.com/jackwener/browsermcp/actions/workflows/release.yml), choose **Run workflow** on `main`, and enter an unused version such as `0.0.20`.
3. Optionally enter release notes. If omitted, the workflow uses commit subjects since the previous tag. An existing `CHANGELOG.md` section for that version takes precedence.

The workflow updates `package.json`, `package-lock.json`, and `CHANGELOG.md`, runs a small set of checks, builds and installs the tarball, validates that the extension's public key produces the ID allowed by the native host, commits the release version, pushes its tag, publishes to npm with provenance, creates a GitHub Release with the tarball and manual-install extension zip, and waits for npm to expose the version. Re-run the same version if publication or release creation fails after the tag was pushed; it checks the existing tag and package instead of bumping again.

The manual-install zip keeps `manifest.key` and is meant to be extracted and loaded through Chrome's **Load unpacked**. The `npm run pack:store` zip removes that key and is only for Web Store upload. Do not use the store zip for manual installation. The extension manifest version is independent of the npm package version.

## Embedded prereleases

Run the same `release.yml` workflow on `codex/embedded-electron` with an unused version such as `0.0.34-embedded.0`. This branch publishes the same npm package under the `embedded` dist-tag and creates a GitHub prerelease. It does not update `latest` or publish a manual extension zip.

The embedded job checks types and adapter isolation, builds the package, and runs real Electron smoke tests both directly and with the installed package inside `app.asar` before publishing. For an already validated build, `skip_embedded_tests` skips the type and Electron checks. It uses the same npm Trusted Publisher configuration as stable releases.

Consumers install `npm install @jackwener/browsermcp@embedded` and import `@jackwener/browsermcp/embedded`. Pin the exact prerelease version for reproducible application builds.

Keep `codex/embedded-electron` exactly one commit above current `main`: land shared changes on `main`, then rebase and squash the Electron-specific change. The embedded release job enforces this relationship and amends version/changelog changes into that single commit, pushing with an explicit lease. Existing published tags remain immutable.
