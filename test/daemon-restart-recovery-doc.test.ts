import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const documentation = readFileSync(
  resolve(process.cwd(), "docs", "daemon-restart-recovery.md"),
  "utf8",
);
const normalizedDocumentation = documentation.replace(/\s+/gu, " ");

function descriptorPolicy(fd: number): string {
  const row = documentation
    .split("\n")
    .find((line) => line.startsWith(`| ${fd} |`));
  if (row === undefined) throw new Error(`missing descriptor policy for FD ${fd}`);
  return row;
}

describe("daemon restart recovery descriptor ABI documentation", () => {
  it("keeps both supported FD 3 package-owner pairs exact", () => {
    const policy = descriptorPolicy(3);

    expect(policy).toContain(
      "owner pair exactly either `0:0` or the invoking effective UID:GID",
    );
    expect(normalizedDocumentation).toContain(
      "every mixed or different owner pair is rejected",
    );
  });

  it("admits only static ET_EXEC or structurally static-PIE ET_DYN helper images", () => {
    const policy = descriptorPolicy(3);

    expect(policy).toContain("either `ET_EXEC` or `ET_DYN`");
    expect(policy).toContain("no `PT_INTERP` program header");
    expect(policy).toContain("no `DT_NEEDED` dynamic entry");
    expect(policy).toContain(
      "`ET_DYN` is admitted only in that structurally validated static-PIE form",
    );
    expect(normalizedDocumentation).toContain(
      "reject `ET_DYN` carrying either `PT_INTERP` or `DT_NEEDED`",
    );
  });
});
