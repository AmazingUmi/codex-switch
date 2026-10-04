import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const target = "aarch64-apple-darwin";
export const repository = "AmazingUmi/codex-switch";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr ?? ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

export function sourceState() {
  const hash = createHash("sha256");
  const paths = [
    ...new Set(
      run("git", [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  for (const path of paths) {
    const file = join(root, path);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") {
        hash.update(`${path}\0deleted\0`);
        continue;
      }
      throw error;
    }
    hash.update(`${path}\0${stat.mode & 0o777}\0`);
    hash.update(
      stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file),
    );
    hash.update("\0");
  }
  return {
    commit: run("git", ["rev-parse", "HEAD"]),
    dirty: Boolean(run("git", ["status", "--porcelain"])),
    fingerprint: hash.digest("hex"),
  };
}

export function metadata() {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)),
  );
  const cargo = readFileSync(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  const cargoVersion = cargo
    .match(/\[package\]([\s\S]*?)(?=\n\[)/)?.[1]
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lock = readFileSync(
    new URL("../src-tauri/Cargo.lock", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const lockVersion = lock.match(
    /\[\[package\]\]\nname = "codex-switch"\nversion = "([^"]+)"/,
  )?.[1];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error(
      "Release version must be a semantic version without build metadata.",
    );
  }
  if (
    [config.version, cargoVersion, lockVersion].some(
      (version) => version !== pkg.version,
    )
  ) {
    throw new Error(
      "package.json, Tauri config, Cargo.toml and Cargo.lock versions must match.",
    );
  }
  if (
    config.identifier !== "com.codexswitch.desktop" ||
    config.productName !== "Codex Switch"
  ) {
    throw new Error(
      "Release must use the independent Codex Switch production identity.",
    );
  }
  if (
    config.bundle.createUpdaterArtifacts !== false ||
    config.plugins?.updater?.endpoints?.length
  ) {
    throw new Error(
      "First release must use manual downloads with no updater artifacts/endpoints.",
    );
  }
  if (config.bundle.macOS.minimumSystemVersion !== "12.0") {
    throw new Error("Release platform contract requires macOS 12.0 minimum.");
  }
  return { version: pkg.version, tag: `v${pkg.version}`, config };
}

export function validateTag(tag) {
  const info = metadata();
  if (tag !== info.tag)
    throw new Error(`Expected release tag ${info.tag}; received ${tag}.`);
  const commit = run("git", ["rev-parse", "HEAD"]);
  if (run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit) {
    throw new Error("Build checkout must be the exact tagged commit.");
  }
  run("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  if (run("git", ["status", "--porcelain"]).length)
    throw new Error("Release checkout must be clean.");
  return { ...info, commit };
}

export function signingMode(env = process.env) {
  const keys = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ];
  const present = keys.filter((key) => Boolean(env[key]));
  // A local/CI explicit '-' is the ad-hoc identity, not an incomplete Apple secret.
  if (present.length === 1 && env.APPLE_SIGNING_IDENTITY === "-")
    return "adhoc";
  if (!present.length) return "adhoc";
  if (present.length !== keys.length) {
    throw new Error(
      `Incomplete Apple signing configuration; missing: ${keys.filter((key) => !env[key]).join(", ")}.`,
    );
  }
  if (!env.APPLE_SIGNING_IDENTITY.startsWith("Developer ID Application:")) {
    throw new Error(
      "Notarized release requires a Developer ID Application signing identity.",
    );
  }
  return "notarized";
}
