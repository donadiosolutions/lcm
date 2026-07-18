import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scrubExtractedEvents } from "../../src/hooks/event-scrubbing.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("passive event scrubbing", () => {
  it("redacts content and tags before sidecar persistence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-scrub-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([{
      type: "decision",
      category: "decision",
      data: "always use GLOBAL-1234",
      priority: 1,
      tags: ["token:GLOBAL-1234"],
    }], cwd, ["GLOBAL-[0-9]{4}"]);
    expect(events[0]).toMatchObject({
      data: "always use [REDACTED]",
      tags: ["[REDACTED]"],
    });
  });

  it("loads default configuration when patterns are not injected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-event-default-scrub-"));
    dirs.push(cwd);
    const events = await scrubExtractedEvents([{
      type: "decision", category: "decision", data: `token sk-${"a".repeat(24)}`, priority: 1,
    }], cwd);
    expect(events[0].data).toContain("[REDACTED]");
  });
});
