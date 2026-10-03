import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  metadata,
  repository,
  root,
  run,
  sourceState,
  target,
} from "./release-common.mjs";

if (process.platform !== "darwin")
  throw new Error("Release verification requires macOS tools.");
const { version, tag, config } = metadata();
const signing = process.env.RELEASE_SIGNING_MODE;
if (!["adhoc", "notarized"].includes(signing))
  throw new Error(
    "Set RELEASE_SIGNING_MODE to adhoc or notarized to verify the intended signature.",
  );
const bundle = join(root, "src-tauri", "target", target, "release", "bundle");
const built = JSON.parse(
  readFileSync(join(bundle, "RELEASE_BUILD.json"), "utf8"),
);
const source = sourceState();
if (
  built.version !== version ||
  built.target !== target ||
  built.signing !== signing ||
  built.commit !== source.commit ||
  built.dirty !== source.dirty ||
  built.fingerprint !== source.fingerprint
)
  throw new Error(
    "Built artifacts do not match the current source/signing state. Rebuild before staging.",
  );
const app = join(bundle, "macos", "Codex Switch.app");
function verifyApp(appPath) {
  const info = JSON.parse(
    run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(appPath, "Contents", "Info.plist"),
    ]),
  );
  if (
    info.CFBundleIdentifier !== config.identifier ||
    info.CFBundleShortVersionString !== version ||
    info.LSMinimumSystemVersion !== "12.0"
  ) {
    throw new Error(
      "Actual app identity, version or minimum macOS version differs from release contract.",
    );
  }
  if (
    run("/usr/bin/lipo", [
      "-archs",
      join(appPath, "Contents", "MacOS", info.CFBundleExecutable),
    ]) !== "arm64"
  )
    throw new Error("Release executable must contain only arm64.");
  const buildVersion = run("/usr/bin/xcrun", [
    "vtool",
    "-show-build",
    join(appPath, "Contents", "MacOS", info.CFBundleExecutable),
  ]);
  const minOS = buildVersion.match(/\bminos\s+(\d+)\.(\d+)(?:\.(\d+))?/);
  if (
    !minOS ||
    Number(minOS[1]) !== 12 ||
    Number(minOS[2]) !== 0 ||
    Number(minOS[3] ?? 0) !== 0
  )
    throw new Error("Actual Mach-O deployment target must be macOS 12.0.");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  // codesign's display output is written to stderr even on success.
  const signature = run("/bin/sh", [
    "-c",
    'exec /usr/bin/codesign -dv --verbose=4 "$1" 2>&1',
    "release-signature",
    appPath,
  ]);
  if (signing === "adhoc" && !signature.includes("Signature=adhoc"))
    throw new Error("Expected an ad-hoc signature.");
  if (signing === "notarized") {
    if (!signature.includes("Authority=Developer ID Application:"))
      throw new Error("Expected a Developer ID Application signature.");
    run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]);
  }
}
function appDigest(appPath) {
  const hash = createHash("sha256");
  function visit(relative) {
    const path = join(appPath, relative);
    const stat = lstatSync(path);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) hash.update(`link\0${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const child of readdirSync(path).sort())
        visit(join(relative, child));
    } else {
      hash.update("file\0");
      hash.update(readFileSync(path));
    }
    hash.update("\0");
  }
  visit("");
  return hash.digest("hex");
}
verifyApp(app);
const dmgs = readdirSync(join(bundle, "dmg")).filter((file) =>
  file.endsWith(".dmg"),
);
if (dmgs.length !== 1)
  throw new Error("Expected exactly one freshly built DMG.");
const dmg = join(bundle, "dmg", dmgs[0]);
run("/usr/bin/hdiutil", ["verify", dmg]);
const mountPoint = mkdtempSync(join(tmpdir(), "codex-switch-release-"));
let attached = false;
try {
  const mountPlist = run("/usr/bin/hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mountPoint,
    "-plist",
    dmg,
  ]);
  attached = true;
  const mounted = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: mountPlist,
    }),
  );
  if (
    !mounted["system-entities"].some(
      (entity) => entity["mount-point"] === mountPoint,
    )
  )
    throw new Error("DMG did not mount at the requested path.");
  const embeddedApp = join(mountPoint, "Codex Switch.app");
  verifyApp(embeddedApp);
  if (appDigest(embeddedApp) !== appDigest(app))
    throw new Error("DMG app payload differs from the verified built app.");
} finally {
  if (attached) run("/usr/bin/hdiutil", ["detach", mountPoint]);
  rmdirSync(mountPoint);
}
const stage = join(root, "src-tauri", "target", "release-assets");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const assetName = `Codex-Switch_${version}_macOS_arm64${signing === "adhoc" ? "_adhoc" : ""}.dmg`;
copyFileSync(join(bundle, "dmg", dmgs[0]), join(stage, assetName));
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
const manifest = {
  repository,
  tag,
  version,
  commit: source.commit,
  dirty: source.dirty,
  sourceFingerprint: source.fingerprint,
  target,
  minimumMacOS: "12.0",
  signing,
  asset: assetName,
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
};
writeFileSync(
  join(stage, "RELEASE_MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const files = [assetName, "LICENSE", "RELEASE_MANIFEST.json"];
writeFileSync(
  join(stage, "SHA256SUMS"),
  files
    .map(
      (file) =>
        `${createHash("sha256")
          .update(readFileSync(join(stage, file)))
          .digest("hex")}  ${file}\n`,
    )
    .join(""),
);
const signingNote =
  signing === "adhoc"
    ? "This testing build is ad-hoc signed and is **not Apple notarized**. macOS may block the first launch; after attempting to open it, use System Settings → Privacy & Security → Open Anyway only if you trust this release."
    : "This build is signed with Developer ID Application, Apple notarized, and its app ticket has been verified.";
writeFileSync(
  join(stage, "RELEASE_NOTES.md"),
  `Codex Switch ${tag} is a macOS testing pre-release.\n\n- Apple Silicon (M1 and later); configured minimum macOS version: 12.0. Intel, Windows and Linux installation packages are not included in this release.\n- ${signingNote}\n- Download \`${assetName}\`, open it, and drag Codex Switch into Applications.\n- Updates use manual downloads from this repository's Releases page.\n- Verify downloads with \`shasum -a 256 -c SHA256SUMS\` alongside the DMG, LICENSE and RELEASE_MANIFEST.json files.\n- Based on [CC Switch](https://github.com/farion1231/cc-switch), distributed under the included MIT license.\n\nValidation limits: runtime testing on macOS 12, live OAuth/account switching, and light/dark Retina tray acceptance are NOT_RUN by this packaging workflow. The configured minimum version is not a claim that those checks passed.\n\nSource commit: \`${manifest.commit}\`.\n`,
);
console.log(`Verified and staged release assets in ${stage}.`);
