import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function generate(args) {
  const result = spawnSync(pnpm, ["tauri", "icon", ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("App icon generation failed.");
}

generate(["src/assets/icons/codex-switch.svg"]);
// Tauri emits ICNS records from a hash map. Keep the container order stable
// without changing the generated image payloads.
const icnsPath = join(projectRoot, "src-tauri/icons/icon.icns");
const icns = readFileSync(icnsPath);
const records = [];
for (let offset = 8; offset < icns.length; ) {
  const size = icns.readUInt32BE(offset + 4);
  if (size < 8 || offset + size > icns.length) {
    throw new Error("Invalid generated ICNS record.");
  }
  records.push(icns.subarray(offset, offset + size));
  offset += size;
}
records.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
writeFileSync(icnsPath, Buffer.concat([icns.subarray(0, 8), ...records]));
copyFileSync(
  join(projectRoot, "src-tauri/icons/icon.png"),
  join(projectRoot, "src/assets/icons/app-icon.png"),
);

const trayOutput = mkdtempSync(join(tmpdir(), "codex-switch-tray-"));
try {
  generate([
    "src/assets/icons/codex-switch-tray.svg",
    "--output",
    trayOutput,
    "--png",
    "18",
    "--png",
    "36",
    "--png",
    "54",
  ]);
  for (const [size, file] of [
    [18, "statusTemplate.png"],
    [36, "statusTemplate@2x.png"],
    [54, "statusbar_template_3x.png"],
  ]) {
    copyFileSync(
      join(trayOutput, `${size}x${size}.png`),
      join(projectRoot, "src-tauri/icons/tray/macos", file),
    );
  }
} finally {
  rmSync(trayOutput, { recursive: true, force: true });
}
