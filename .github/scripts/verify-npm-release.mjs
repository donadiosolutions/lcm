import { verifyNpmRelease } from "./npm-release-policy.mjs";

const version = process.argv[2];
if (!version) throw new Error("Usage: verify-npm-release.mjs VERSION");

verifyNpmRelease({ version });
