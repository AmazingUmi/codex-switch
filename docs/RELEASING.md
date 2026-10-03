# Releasing Codex Switch

The first release channel is a macOS Pre-release in `AmazingUmi/codex-switch`: Apple Silicon (M1 and later), a configured minimum of macOS 12.0, installed from a DMG. Updates use manual downloads. Intel, Windows and Linux installers are not shipped by this workflow. Runtime acceptance on macOS 12, live OAuth/account switching and light/dark Retina tray checks are not performed by the packaging workflow; record their actual results separately.

## Publish from the fork

1. Push the feature branch to `origin` and merge its reviewed PR into this fork's `main`. Keep the original MIT license and CC Switch attribution.
2. Ensure `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the root package in `src-tauri/Cargo.lock` contain the same version. Run the repository's frontend/native checks and CI before tagging.
3. On the clean merged commit, create and push its version tag:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.0.2 -m 'Codex Switch v0.0.2'
   git push origin v0.0.2
   ```

4. The **macOS Pre-release** workflow builds a production release DMG and creates a **draft Pre-release** with the DMG, `LICENSE`, `RELEASE_MANIFEST.json` and `SHA256SUMS`. Its Actions artifact also includes generated release notes. Download and inspect the DMG, test launching/installing it, and check account switching, OAuth and quota display before publishing the draft.
5. Add relevant changes from the changelog to the draft's generated platform/signing notes, then publish it while keeping **Pre-release** enabled.

The optional manual workflow takes an **existing** version tag on `main`. It checks out that tag, not the workflow's current branch. Tag, manifest versions, commit ancestry and a clean checkout are verified. Existing releases are refused; inspect any existing draft before deleting it and rerunning, and never move a public version tag to different source. A successful build records source commit/content/signing provenance. Staging rejects source changes since that build, verifies the app identity, arm64 executable, Mach-O deployment target and signature, mounts the DMG read-only, and verifies its embedded app against the built app before detaching. Only freshly generated, verified bundles are uploaded.

## macOS signing

With no Apple secrets, the workflow deliberately uses the ad-hoc identity `-`. The filename ends in `_adhoc.dmg`, and the release notes state that it is a testing build without Apple notarization. macOS may require **Privacy & Security → Open Anyway** after the first attempted launch. Ad-hoc signing does not provide an Apple-verified developer identity.

For Developer ID signing and notarization, configure all six repository Actions secrets:

| Secret                       | Value                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded exported Developer ID Application `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Export password for that `.p12`                                                    |
| `APPLE_SIGNING_IDENTITY`     | Full `Developer ID Application: …` identity                                        |
| `APPLE_ID`                   | Apple developer account email                                                      |
| `APPLE_PASSWORD`             | Apple **app-specific** password for notarization                                   |
| `APPLE_TEAM_ID`              | Apple developer team ID                                                            |

A partial secret set fails before building. With all six secrets, Tauri signs and notarizes the app; verification checks the Developer ID signature, stapled app ticket and Gatekeeper assessment before staging. Failed signing/notarization never falls back to ad-hoc. This channel currently uses Apple ID authentication rather than App Store Connect API keys.

## Local release build

Use the pinned Node/pnpm and Rust versions, and install the `aarch64-apple-darwin` Rust target. On a Mac with dependencies installed:

```sh
pnpm install --frozen-lockfile
node scripts/release-build.mjs
RELEASE_SIGNING_MODE=adhoc node scripts/release-stage.mjs
```

The build uses the production identity `com.codexswitch.desktop`, the release profile and locked Cargo dependencies. It removes previous bundles under `src-tauri/target/aarch64-apple-darwin/release/bundle` before building, while retaining dependency caches. Verified assets are staged under `src-tauri/target/release-assets`. A local uncommitted build is marked `dirty` in its manifest and cannot be published by the publishing script. For a notarized local build supply the six credentials above and stage with `RELEASE_SIGNING_MODE=notarized`.

The release command sets `CI=true` and prevents the DMG bundler's CI override, so local and Actions packaging skip Finder's cosmetic AppleScript. The DMG still includes the app and Applications link; packaging does not require granting Finder automation access.

`pnpm build:preview` creates an isolated debug preview app; use the release command above for published DMGs. The release workflow does not create updater signatures or `latest.json`.

Primary references: [Tauri GitHub distribution](https://v2.tauri.app/distribute/pipelines/github/) and [macOS signing and notarization](https://v2.tauri.app/distribute/sign/macos/).
