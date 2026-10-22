# Releasing BrowserMCP

The npm package and Chrome extension have separate versions. Each npm release also attaches the current key-bearing extension build as a manual-install zip to GitHub Releases. Update the Chrome Web Store extension separately when extension code changes.

## One-time npm setup

In the [browsermcp npm package settings](https://www.npmjs.com/package/@jackwener/browsermcp), add a **Trusted Publisher** for GitHub Actions:

- GitHub owner: `jackwener`
- Repository: `BrowserMCP` (case-sensitive)
- Workflow filename: `release.yml`
- Environment: leave blank
- Allowed actions: enable **Allow npm publish** for direct, unattended releases. Stage-only publishing requires human approval for every release.

The owner, repository and workflow filename must match exactly. New publisher configurations must complete their first successful publish within two days; expired or incorrectly configured entries must be replaced in npm package settings.

The workflow uses GitHub OIDC to publish to npm. It does not need an `NPM_TOKEN` secret. GitHub Actions must be enabled for this repository.

Trusted Publisher configuration belongs to `@jackwener/browsermcp`; another package's configuration does not carry over. Upload **BrowserMCP Connector** as an update to the existing Web Store item, preserving its extension ID and incrementing the extension version.

## Each release

1. Commit and push the changes you want to release to `main`.
2. Open [Actions → Release npm package and manual extension](https://github.com/jackwener/browsermcp/actions/workflows/release.yml), choose **Run workflow** on `main`, and enter an unused version such as `0.0.20`.
3. Optionally enter release notes. If omitted, the workflow uses commit subjects since the previous tag. An existing `CHANGELOG.md` section for that version takes precedence.

The workflow updates `package.json`, `package-lock.json`, and `CHANGELOG.md`, runs a small set of checks, builds and installs the tarball, validates that the extension's public key produces the ID allowed by the native host, commits the release version, pushes its tag, publishes to npm with provenance, verifies the version and channel on npm, and only then creates a GitHub Release with the tarball and manual-install extension zip. Re-run the same version if publication or release creation fails after the tag was pushed; it checks the existing tag and package instead of bumping again.

The manual-install zip keeps `manifest.key` and is meant to be extracted and loaded through Chrome's **Load unpacked**. The `npm run pack:store` zip removes that key and is only for Web Store upload. Do not use the store zip for manual installation. The extension manifest version is independent of the npm package version.

## Embedded prereleases

Run the same `release.yml` workflow on `codex/embedded-electron` with an unused version such as `0.0.34-embedded.0`. This branch publishes the same npm package under the `embedded` dist-tag and creates a GitHub prerelease. It does not update `latest` or publish a manual extension zip.

The embedded job checks types and adapter isolation, builds the package, and runs real Electron smoke tests both directly and with the installed package inside `app.asar` before publishing. For an already validated build, `skip_embedded_tests` skips the type and Electron checks. It uses the same npm Trusted Publisher configuration as stable releases.

Consumers install `npm install @jackwener/browsermcp@embedded` and import `@jackwener/browsermcp/embedded`. Pin the exact prerelease version for reproducible application builds.

Keep `codex/embedded-electron` exactly one commit above current `main`: land shared changes on `main`, then rebase and squash the Electron-specific change. The embedded release job enforces this relationship and amends version/changelog changes into that single commit, pushing with an explicit lease. Existing published tags remain immutable.

## Authentication failures

Do not fall back to local `npm login`, interactive publishing, or a long-lived `NPM_TOKEN`. Inspect the package's Trusted Publisher configuration against the values above, especially repository capitalization, `release.yml`, the blank environment and **Allow npm publish**. The workflow already runs on GitHub-hosted runners with Node 24, npm 11.5.1+ and `id-token: write`. `npm whoami` checks local credentials, not OIDC permissions. Verify the configuration by publishing through this workflow.

The workflow never requests a maintainer's OTP. If direct publishing is not permitted, fix the one-time trust configuration rather than approving a staged package for each release. Keep published tags immutable; retry the same version only from the same release commit.

Reference: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
