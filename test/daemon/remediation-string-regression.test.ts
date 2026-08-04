import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAEMON_REFUSAL_REASONS,
  mapDaemonRefusalToRemediation,
} from "../../src/daemon/remediation.js";

const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const productionFiles = [
  "bin/lcm.ts",
  "src/doctor/doctor.ts",
  "src/cli-help.ts",
  "src/hooks/user-prompt.ts",
  "src/hooks/compact.ts",
  "src/hooks/restore.ts",
  "src/hooks/session-end.ts",
  "src/mcp/server.ts",
];

describe("centralized remediation guidance", () => {
  it("keeps production guidance free of stale manual kill/start loops", () => {
    const source = productionFiles
      .map(file => readFileSync(join(repositoryRoot, file), "utf8"))
      .join("\n");
    expect(source).not.toContain("stop the stale daemon process");
    expect(source).not.toContain("lcm daemon start --detach");
    expect(source).not.toContain("lcm daemon start --foreground");
    expect(source).not.toMatch(/(?:Fix|Try|Start it with|run:)\s*[^\n]*(?:kill|pkill)/u);
    expect(source).not.toMatch(/(?:Fix|Try|Start it with|run:)\s*[^\n]*(?:--foreground|--detach)/u);
  });

  it("keeps every lifecycle refusal reason on the bounded remediation map", () => {
    for (const reason of DAEMON_REFUSAL_REASONS) {
      const guidance = mapDaemonRefusalToRemediation(reason);
      expect(guidance.message).toContain(`(${reason})`);
      expect(guidance.message).not.toMatch(/kill|pkill|foreground|pid|\/|[A-Za-z]:\\/iu);
    }
  });
});
