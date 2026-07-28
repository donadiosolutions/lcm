import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMergeQueueUsesMerge } from "./merge-queue-policy.mjs";

const API_VERSION = "2022-11-28";
const ID_PATTERN = /^[1-9]\d*$/u;
const DEFAULT_BRANCH_PATTERN = /^(?!.*[\u0000-\u001f\u007f])[^/].{0,254}$/u;

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
  const headers = [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ];
  const repositoryRecord = request([...headers, `repos/${repository}`]);
  const defaultBranch = repositoryRecord?.default_branch;
  if (typeof defaultBranch !== "string" || !DEFAULT_BRANCH_PATTERN.test(defaultBranch)) {
    throw new Error("The repository returned an invalid default branch");
  }

  const pages = request([
    ...headers,
    "--paginate",
    "--slurp",
    `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("The paginated repository ruleset response was malformed");
  }

  const activeBranchRulesetIds = new Set(
    pages
      .flat()
      .filter((ruleset) => ruleset?.enforcement === "active" && ruleset?.target === "branch")
      .map((ruleset) => {
        const id = String(ruleset.id);
        if (!ID_PATTERN.test(id)) {
          throw new Error("An active branch ruleset had an invalid identifier");
        }
        return id;
      }),
  );
  const appliedRules = request([
    ...headers,
    `repos/${repository}/rules/branches/${encodeURIComponent(defaultBranch)}`,
  ]);
  if (!Array.isArray(appliedRules)) {
    throw new Error("The applied default-branch rules response was malformed");
  }
  for (const rule of appliedRules) {
    if (rule?.type !== "merge_queue") continue;
    const id = String(rule.ruleset_id);
    if (!ID_PATTERN.test(id) || !activeBranchRulesetIds.has(id)) {
      throw new Error("An applied merge queue did not match an active branch ruleset");
    }
  }
  return assertMergeQueueUsesMerge(appliedRules);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkMergeQueuePolicy({ repository: process.env.GITHUB_REPOSITORY });
  console.log(`Verified ${result.queueCount} default-branch merge queue(s) use MERGE.`);
}
