import { describe, it, expect } from "vitest";
import { eventsDbPath, eventsDir } from "../../src/db/events-path.js";
import { join } from "node:path";
import { homedir } from "node:os";

describe("eventsDbPath", () => {
  it("returns a path under ~/.lcm/events/", () => {
    const result = eventsDbPath("/some/project");
    expect(result).toMatch(/\.lcm\/events\/.+\.db$/);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project");
    const b = eventsDbPath("/some/project");
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a");
    const b = eventsDbPath("/project/b");
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("returns ~/.lcm/events", () => {
    expect(eventsDir()).toBe(join(homedir(), ".lcm", "events"));
  });
});
