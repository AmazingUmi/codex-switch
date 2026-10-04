import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metadata, sourceState } from "./release-common.mjs";
import {
  buildPlan,
  paths,
  readConfig,
  runPlan,
  target,
  variantFromArgs,
} from "./windows-packaging.mjs";

if (process.platform !== "win32")
  throw new Error("Windows NSIS packages must be built on Windows.");
const variant = variantFromArgs(process.argv.slice(2));
const { version } = metadata();
const source = sourceState();
const config = readConfig(variant);
const output = paths(variant);
mkdirSync(output.directory, { recursive: true });
// Keep dependency caches, but stale installers must never be staged.
rmSync(output.bundle, { recursive: true, force: true });
writeFileSync(output.config, `${JSON.stringify(config, null, 2)}\n`);
runPlan(buildPlan(variant, output.config));
if (JSON.stringify(sourceState()) !== JSON.stringify(source))
  throw new Error("Source changed during the build; rebuild before staging.");
writeFileSync(
  join(output.bundle, "WINDOWS_BUILD.json"),
  `${JSON.stringify(
    {
      ...source,
      version,
      variant,
      target,
      identifier: config.identifier,
      productName: config.productName,
      rendererPreview: variant === "preview",
      rustFeatures: variant === "preview" ? ["codex-preview"] : [],
      signing: "unsigned",
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${variant} Windows x64 NSIS package in ${output.bundle}.`);
