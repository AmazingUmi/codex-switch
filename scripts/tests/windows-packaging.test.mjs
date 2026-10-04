import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildPlan,
  paths,
  readConfig,
  variantFromArgs,
  windowsConfig,
} from "../windows-packaging.mjs";
import { metadata } from "../release-common.mjs";

const base = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url)),
);
const windows = JSON.parse(
  readFileSync(
    new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url),
  ),
);
const preview = JSON.parse(
  readFileSync(
    new URL("../../src-tauri/tauri.preview.conf.json", import.meta.url),
  ),
);

test("canonical variants reject unknown arguments", () => {
  assert.equal(variantFromArgs([]), "production");
  assert.equal(variantFromArgs(["--preview"]), "preview");
  for (const args of [["preview"], ["--debug"], ["--preview", "--preview"]])
    assert.throws(() => variantFromArgs(args), /Usage/);
});

test("Windows merge preserves main window dimensions and preview title/identity", () => {
  for (const variant of ["production", "preview"]) {
    const config = readConfig(variant);
    const main = config.app.windows[0];
    for (const key of [
      "width",
      "height",
      "minWidth",
      "minHeight",
      "center",
      "resizable",
      "visible",
    ])
      assert.equal(
        main[key],
        windows.app.windows[0][key] ?? base.app.windows[0][key],
      );
    assert.equal(main.titleBarStyle, "Visible");
    assert.equal(main.title, config.productName);
    assert.equal(
      config.identifier,
      variant === "preview"
        ? "com.codexswitch.preview"
        : "com.codexswitch.desktop",
    );
    assert.deepEqual(config.bundle.targets, ["nsis"]);
  }
  assert.deepEqual(readConfig("preview").plugins["deep-link"].desktop, []);
});

test("plain Windows dev/build preserves the base main window despite array replacement", () => {
  for (const [key, value] of Object.entries(base.app.windows[0])) {
    if (["title", "titleBarStyle"].includes(key)) continue;
    assert.deepEqual(
      windows.app.windows[0][key],
      value,
      `Windows main window ${key}`,
    );
  }
  assert.equal(windows.app.windows[0].title, "Codex Switch");
  assert.equal(windows.app.windows[0].titleBarStyle, "Visible");
});

test("preview config refuses production protocol registration", () => {
  const unsafe = structuredClone(preview);
  unsafe.plugins["deep-link"].desktop = { schemes: ["codexswitch"] };
  assert.throws(
    () => windowsConfig(base, windows, unsafe, "preview"),
    /URL protocols/,
  );
});

test("Windows installer contract refuses all-user installation", () => {
  const unsafe = structuredClone(windows);
  unsafe.bundle.windows.nsis.installMode = "both";
  assert.throws(
    () => windowsConfig(base, unsafe, preview, "production"),
    /per-user/,
  );
});

test("preview build pairs renderer/native flags and production clears inherited preview state", () => {
  const env = {
    VITE_CODEX_PREVIEW: "true",
    TAURI_CONFIG: "inherited",
    CARGO_TARGET_DIR: "elsewhere",
  };
  const previewPlan = buildPlan("preview", "config.json", env, "linux");
  assert.equal(previewPlan.options.env.VITE_CODEX_PREVIEW, "true");
  assert.ok(previewPlan.args.includes("codex-preview"));
  assert.equal(
    previewPlan.options.env.CARGO_TARGET_DIR,
    paths("preview").directory,
  );
  const productionPlan = buildPlan("production", "config.json", env, "linux");
  assert.equal(productionPlan.options.env.VITE_CODEX_PREVIEW, "false");
  assert.equal(productionPlan.options.env.TAURI_CONFIG, undefined);
  assert.ok(!productionPlan.args.includes("--features"));
  assert.deepEqual(productionPlan.args.slice(-2), ["--", "--locked"]);
  assert.equal(
    productionPlan.args[productionPlan.args.indexOf("--bundles") + 1],
    "nsis",
  );
  assert.notEqual(paths("preview").directory, paths("production").directory);
});

test("Windows pnpm JS entry preserves paths with spaces without shell expansion", () => {
  const config = "C:\\Code Projects\\Codex Switch\\config.json";
  const cli = "C:/Node Tools/pnpm/bin/pnpm.cjs";
  const plan = buildPlan("preview", config, { npm_execpath: cli }, "win32");
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.options.shell, false);
  assert.equal(plan.args[0], cli);
  assert.equal(plan.args[plan.args.indexOf("--config") + 1], config);
});

test("direct-node Windows pnpm.cmd fallback quotes paths and rejects expansion", () => {
  const plan = buildPlan(
    "production",
    "C:\\Code Projects\\config.json",
    {},
    "win32",
  );
  assert.equal(plan.command, "pnpm.cmd");
  assert.equal(plan.options.shell, true);
  assert.ok(plan.args.includes('"C:\\Code Projects\\config.json"'));
  assert.throws(
    () => buildPlan("production", "C:\\%HOME%\\config.json", {}, "win32"),
    /expansion/,
  );
});

test("repository versions are consistent before packaging", () => {
  assert.equal(metadata().version, base.version);
});
