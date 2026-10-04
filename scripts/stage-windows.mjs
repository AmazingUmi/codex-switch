import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { metadata, sourceState } from "./release-common.mjs";
import {
  paths,
  readConfig,
  root,
  target,
  variantFromArgs,
} from "./windows-packaging.mjs";

if (process.platform !== "win32")
  throw new Error("Windows artifact verification requires Windows.");
const variant = variantFromArgs(process.argv.slice(2));
const output = paths(variant);
const config = readConfig(variant);
const { version } = metadata();
const source = sourceState();
const built = JSON.parse(
  readFileSync(join(output.bundle, "WINDOWS_BUILD.json"), "utf8"),
);
if (
  built.version !== version ||
  built.variant !== variant ||
  built.target !== target ||
  built.commit !== source.commit ||
  built.dirty !== source.dirty ||
  built.fingerprint !== source.fingerprint ||
  built.identifier !== config.identifier ||
  built.productName !== config.productName
)
  throw new Error(
    "Windows artifacts do not match the current source and application identity.",
  );
const executable = readFileSync(output.executable);
const peOffset = executable.readUInt32LE(0x3c);
if (
  executable.subarray(0, 2).toString() !== "MZ" ||
  executable.subarray(peOffset, peOffset + 4).toString() !== "PE\0\0" ||
  executable.readUInt16LE(peOffset + 4) !== 0x8664
)
  throw new Error("Windows application must be an x64 PE executable.");
const smoke = JSON.parse(
  readFileSync(join(output.bundle, "WINDOWS_SMOKE.json"), "utf8"),
);
const digest = (data) => createHash("sha256").update(data).digest("hex");
if (
  smoke.variant !== variant ||
  smoke.identifier !== config.identifier ||
  smoke.executableSha256 !== digest(executable) ||
  smoke.status !== "passed"
)
  throw new Error(
    "The installer launch smoke result must match the built executable.",
  );
const installers = readdirSync(join(output.bundle, "nsis")).filter((file) =>
  file.endsWith(".exe"),
);
if (installers.length !== 1)
  throw new Error("Expected exactly one freshly built NSIS installer.");
const installer = join(output.bundle, "nsis", installers[0]);
if (smoke.installerSha256 !== digest(readFileSync(installer)))
  throw new Error(
    "Smoke-tested installer differs from the installer being staged.",
  );
rmSync(output.stage, { recursive: true, force: true });
mkdirSync(output.stage, { recursive: true });
const asset = `Codex-Switch${variant === "preview" ? "-Preview" : ""}_${version}_Windows_x64_unsigned-setup.exe`;
copyFileSync(installer, join(output.stage, asset));
copyFileSync(join(root, "LICENSE"), join(output.stage, "LICENSE"));
copyFileSync(
  join(output.bundle, "WINDOWS_SMOKE.json"),
  join(output.stage, "WINDOWS_SMOKE.json"),
);
writeFileSync(
  join(output.stage, "WINDOWS_MANIFEST.json"),
  `${JSON.stringify(
    {
      repository: process.env.GITHUB_REPOSITORY ?? "AmazingUmi/codex-switch",
      ...built,
      sourceFingerprint: built.fingerprint,
      asset,
      installer: "nsis",
      installMode: "currentUser",
      webView2: "downloadBootstrapper",
      workflowRun: process.env.GITHUB_RUN_ID ?? null,
      workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      smoke: "installer/launch only; no OAuth or visual acceptance coverage",
    },
    null,
    2,
  )}\n`,
);
const files = [asset, "LICENSE", "WINDOWS_MANIFEST.json", "WINDOWS_SMOKE.json"];
writeFileSync(
  join(output.stage, "SHA256SUMS"),
  files
    .map(
      (file) => `${digest(readFileSync(join(output.stage, file)))}  ${file}\n`,
    )
    .join(""),
);
console.log(
  `Verified and staged ${variant} Windows artifacts in ${output.stage}.`,
);
