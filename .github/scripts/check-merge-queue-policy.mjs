import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertMergeQueueUsesMerge } from "./merge-queue-policy.mjs";

const API_VERSION = "2022-11-28";
const ID_PATTERN = /^[1-9]\d*$/u;

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGTERM",
    shell: false,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Failed to inspect repository rulesets with gh");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("gh returned invalid repository ruleset JSON");
  }
}

export function checkMergeQueuePolicy({ repository, request = runGh }) {
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must contain a canonical owner/repository name");
  }
  const pages = request([
    "api",
    "--paginate",
    "--slurp",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("The paginated repository ruleset response was malformed");
  }

  const activeBranchRulesets = pages
    .flat()
    .filter((ruleset) => ruleset?.enforcement === "active" && ruleset?.target === "branch");
  const details = activeBranchRulesets.map((ruleset) => {
    const id = String(ruleset.id);
    if (!ID_PATTERN.test(id)) throw new Error("An active branch ruleset had an invalid identifier");
    return request([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      `repos/${repository}/rulesets/${id}`,
    ]);
  });
  return assertMergeQueueUsesMerge(details);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = checkMergeQueuePolicy({ repository: process.env.GITHUB_REPOSITORY });
  console.log(`Verified ${result.queueCount} active merge-queue rule(s) use MERGE.`);
}
