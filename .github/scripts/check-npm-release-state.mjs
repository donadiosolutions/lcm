import { checkNpmReleaseState } from "./release-policy.mjs";

const version = process.argv[2];
if (!version) throw new Error("Usage: check-npm-release-state.mjs VERSION");

const { alreadyPublished } = checkNpmReleaseState({ version });
process.stdout.write(`already_published=${alreadyPublished}\n`);
