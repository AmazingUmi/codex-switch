import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The current preview bundle is validated for macOS only.");
}

// Pair the renderer flag, native feature and bundle identity in one command.
// Runtime isolation is compiled into the executable, so Finder launches and
// app restarts do not depend on the shell used to build this app.
const result = spawnSync(
  "pnpm",
  [
    "tauri",
    "build",
    "--debug",
    "--features",
    "codex-preview",
    "--config",
    "src-tauri/tauri.preview.conf.json",
    "--bundles",
    "app",
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, VITE_CODEX_PREVIEW: "true" },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// The bundler also merges src-tauri/Info.plist. Verify the actual output so a
// future static protocol entry cannot silently claim the regular app's links.
const bundle = fileURLToPath(
  new URL(
    "../src-tauri/target/debug/bundle/macos/Codex Switch Preview.app/Contents/Info.plist",
    import.meta.url,
  ),
);
const metadata = spawnSync(
  "/usr/bin/plutil",
  ["-convert", "json", "-o", "-", bundle],
  {
    encoding: "utf8",
  },
);
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) throw new Error(metadata.stderr);
const info = JSON.parse(metadata.stdout);
if (
  info.CFBundleIdentifier !== "com.codexswitch.preview" ||
  info.CFBundleName !== "Codex Switch Preview" ||
  (info.CFBundleURLTypes?.length ?? 0) !== 0
) {
  throw new Error(
    "Preview bundle identity or deep-link isolation validation failed.",
  );
}
console.log("Verified preview identity and absence of external URL schemes.");

// Debug bundling may leave an executable signature that expects bundle
// resources without sealing the bundle itself. Seal this local preview with an
// ad-hoc signature; this does not use a developer identity or notarize the app.
const appBundle = dirname(dirname(bundle));
for (const args of [
  ["--force", "--deep", "--sign", "-", appBundle],
  ["--verify", "--deep", "--strict", appBundle],
]) {
  const signing = spawnSync("/usr/bin/codesign", args, { stdio: "inherit" });
  if (signing.error) throw signing.error;
  if (signing.status !== 0) process.exit(signing.status ?? 1);
}
console.log("Verified local ad-hoc bundle signature.");
