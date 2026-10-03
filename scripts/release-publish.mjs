import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repository, root, run, validateTag } from "./release-common.mjs";

if (process.env.GITHUB_REPOSITORY !== repository)
  throw new Error(`Release publishing is restricted to ${repository}.`);
const { tag, commit } = validateTag(process.env.RELEASE_TAG);
const existing = spawnSync(
  "gh",
  ["api", `repos/${repository}/releases/tags/${tag}`],
  { encoding: "utf8" },
);
if (existing.error) throw existing.error;
if (existing.status === 0)
  throw new Error(
    `Release ${tag} already exists. Inspect it before attempting any replacement.`,
  );
if (!existing.stderr.includes("HTTP 404"))
  throw new Error(`Unable to check existing release: ${existing.stderr}`);
if (process.argv.slice(2).join() === "--check-only") {
  console.log(`No existing release for ${tag}; draft creation is available.`);
  process.exit(0);
}
const stage = join(root, "src-tauri", "target", "release-assets");
const manifest = JSON.parse(
  readFileSync(join(stage, "RELEASE_MANIFEST.json"), "utf8"),
);
if (
  manifest.repository !== repository ||
  manifest.commit !== commit ||
  manifest.tag !== tag ||
  manifest.dirty
)
  throw new Error(
    "Staged artifacts do not belong to this clean tagged checkout.",
  );
for (const line of readFileSync(join(stage, "SHA256SUMS"), "utf8")
  .trim()
  .split("\n")) {
  const [hash, file] = line.split("  ");
  if (
    !file ||
    file.includes("/") ||
    file.includes("\\") ||
    createHash("sha256")
      .update(readFileSync(join(stage, file)))
      .digest("hex") !== hash
  )
    throw new Error("Staged release checksum mismatch.");
}
run(
  "gh",
  [
    "release",
    "create",
    tag,
    ...[manifest.asset, "LICENSE", "RELEASE_MANIFEST.json", "SHA256SUMS"].map(
      (file) => join(stage, file),
    ),
    "--repo",
    repository,
    "--verify-tag",
    "--target",
    commit,
    "--title",
    `Codex Switch ${tag} (macOS Pre-release)`,
    "--notes-file",
    join(stage, "RELEASE_NOTES.md"),
    "--draft",
    "--prerelease",
  ],
  { stdio: "inherit" },
);
