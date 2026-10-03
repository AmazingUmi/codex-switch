import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  metadata,
  root,
  run,
  signingMode,
  sourceState,
  target,
} from "./release-common.mjs";

if (process.platform !== "darwin")
  throw new Error("Release DMG must be built on macOS.");
const { version } = metadata();
const signing = signingMode();
const source = sourceState();
// Remove previous bundles without discarding compiled dependency caches.
rmSync(join(root, "src-tauri", "target", target, "release", "bundle"), {
  recursive: true,
  force: true,
});
const env = {
  ...process.env,
  // Tauri's DMG bundler checks the environment independently of CLI --ci:
  // CI=true selects --skip-jenkins, avoiding Finder's cosmetic AppleScript.
  // See tauri-cli-v2.8.1/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs.
  CI: "true",
  TAURI_BUNDLER_DMG_IGNORE_CI: "false",
  MACOSX_DEPLOYMENT_TARGET: "12.0",
  APPLE_SIGNING_IDENTITY:
    signing === "adhoc" ? "-" : process.env.APPLE_SIGNING_IDENTITY,
};
delete env.VITE_CODEX_PREVIEW;
// Tauri tests whether these variables exist, so blank GitHub secrets must be
// removed rather than passed through as empty certificate/notarization values.
for (const key of Object.keys(env)) {
  if (key.startsWith("APPLE_") && !env[key]) delete env[key];
}
console.log(`Building production Apple Silicon DMG with ${signing} signing.`);
run(
  "pnpm",
  [
    "tauri",
    "build",
    "--ci",
    "--target",
    target,
    "--bundles",
    "app,dmg",
    "--",
    "--locked",
  ],
  { env, stdio: "inherit" },
);
if (JSON.stringify(sourceState()) !== JSON.stringify(source))
  throw new Error("Source changed during the build; rebuild before staging.");
writeFileSync(
  join(
    root,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
    "RELEASE_BUILD.json",
  ),
  `${JSON.stringify({ ...source, version, signing, target }, null, 2)}\n`,
);
