import { appendFileSync } from "node:fs";
import { repository, signingMode, validateTag } from "./release-common.mjs";

if (process.env.GITHUB_REPOSITORY !== repository)
  throw new Error(`Releases are restricted to ${repository}.`);
const { version, tag, commit } = validateTag(process.env.RELEASE_TAG);
const signing = signingMode();
console.log(
  `Validated ${tag} at ${commit}; Apple Silicon; signing: ${signing}.`,
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=${tag}\ncommit=${commit}\nsigning=${signing}\n`,
  );
}
