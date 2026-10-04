import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const target = "x86_64-pc-windows-msvc";

export function variantFromArgs(args) {
  if (args.length === 0) return "production";
  if (args.length === 1 && args[0] === "--preview") return "preview";
  throw new Error("Usage: pnpm build:windows [--preview]");
}

// Tauri merges arrays by replacement. Preserve the base main window fields
// explicitly before applying the Windows title bar and preview identity.
export function windowsConfig(base, windows, preview, variant) {
  if (!["production", "preview"].includes(variant))
    throw new Error("Unknown Windows build variant.");
  if (base.app.windows.length !== 1 || base.app.windows[0].label !== "main")
    throw new Error(
      "Expected one main window; review the Windows merge contract.",
    );
  if (
    windows.app.windows.length !== 1 ||
    windows.app.windows[0].label !== "main"
  )
    throw new Error("Expected one Windows main window override.");
  const identity = variant === "preview" ? preview : base;
  const productName =
    variant === "preview" ? "Codex Switch Preview" : "Codex Switch";
  const identifier =
    variant === "preview"
      ? "com.codexswitch.preview"
      : "com.codexswitch.desktop";
  if (
    identity.productName !== productName ||
    identity.identifier !== identifier
  )
    throw new Error("Unexpected Windows application identity.");
  if (
    windows.bundle?.windows?.nsis?.installMode !== "currentUser" ||
    windows.bundle?.windows?.webviewInstallMode?.type !== "downloadBootstrapper"
  )
    throw new Error(
      "Windows builds require per-user NSIS and WebView2 bootstrapper.",
    );
  if (
    variant === "preview" &&
    (!Array.isArray(preview.plugins?.["deep-link"]?.desktop) ||
      preview.plugins["deep-link"].desktop.length !== 0)
  )
    throw new Error("Preview must not register external URL protocols.");
  return {
    ...(variant === "preview" ? preview : {}),
    productName,
    identifier,
    app: {
      ...(variant === "preview" ? preview.app : {}),
      windows: [
        {
          ...base.app.windows[0],
          ...windows.app.windows[0],
          title: productName,
        },
      ],
    },
    bundle: {
      ...(variant === "preview" ? preview.bundle : {}),
      targets: ["nsis"],
      createUpdaterArtifacts: false,
    },
  };
}

export function buildPlan(
  variant,
  configPath,
  env = process.env,
  platform = process.platform,
) {
  if (!["production", "preview"].includes(variant))
    throw new Error("Unknown Windows build variant.");
  const buildEnv = {
    ...env,
    CARGO_TARGET_DIR: join(root, "src-tauri", "target", "windows", variant),
  };
  // Explicit false also defeats any local Vite .env preview value.
  buildEnv.VITE_CODEX_PREVIEW = variant === "preview" ? "true" : "false";
  delete buildEnv.TAURI_CONFIG;
  const args = [
    "tauri",
    "build",
    "--ci",
    "--target",
    target,
    "--config",
    configPath,
    "--bundles",
    "nsis",
    ...(variant === "preview" ? ["--features", "codex-preview"] : []),
    "--",
    "--locked",
  ];
  // pnpm exposes its JS entry point to package scripts. Calling it through
  // Node avoids cmd.exe splitting arguments or expanding paths with spaces.
  if (
    platform === "win32" &&
    /^(?:pnpm|pnpm-cli)\.(?:cjs|mjs|js)$/.test(basename(env.npm_execpath ?? ""))
  )
    return {
      command: process.execPath,
      args: [env.npm_execpath, ...args],
      options: { cwd: root, env: buildEnv, stdio: "inherit", shell: false },
    };
  if (platform === "win32") {
    // Direct `node scripts/build-windows.mjs` has no npm_execpath. Batch files
    // need a shell; quote every argument and refuse cmd expansion characters.
    if (args.some((arg) => /["%!\r\n]/.test(arg)))
      throw new Error(
        "Use pnpm build:windows for paths containing cmd expansion characters.",
      );
    return {
      command: "pnpm.cmd",
      args: args.map((arg) => `"${arg}"`),
      options: { cwd: root, env: buildEnv, stdio: "inherit", shell: true },
    };
  }
  return {
    command: "pnpm",
    args,
    options: { cwd: root, env: buildEnv, stdio: "inherit", shell: false },
  };
}

export function readConfig(variant) {
  const read = (name) =>
    JSON.parse(readFileSync(join(root, "src-tauri", name), "utf8"));
  return windowsConfig(
    read("tauri.conf.json"),
    read("tauri.windows.conf.json"),
    read("tauri.preview.conf.json"),
    variant,
  );
}

export function paths(variant) {
  const directory = join(root, "src-tauri", "target", "windows", variant);
  return {
    directory,
    config: join(directory, "build-config.json"),
    bundle: join(directory, target, "release", "bundle"),
    executable: join(directory, target, "release", "codex-switch.exe"),
    stage: join(root, "src-tauri", "target", "windows-assets", variant),
  };
}

export function runPlan(plan) {
  const result = spawnSync(plan.command, plan.args, plan.options);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Windows build failed (${result.status}).`);
}
