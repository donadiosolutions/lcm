import { describe, expect, it, vi } from "vitest";
import { publishPostgreSqlBackend } from "./backend-publication.mjs";

describe("certification backend publication", () => {
  it("publishes PostgreSQL through a completed zero-project coordinator", async () => {
    const sourceConfig = Buffer.from(`${JSON.stringify({ storage: { postgresql: { poolMax: 2 } } }, null, 2)}\n`);
    const source = {
      config: { presence: "present", content: sourceConfig, mode: 0o600, uid: 1, gid: 1, nlink: "1", dev: "1", ino: "1", parentDev: "1", parentIno: "1" },
      projectMap: { presence: "absent", mode: null, uid: null, gid: null, nlink: null, dev: null, ino: null, parentDev: null, parentIno: null },
    };
    const prepare = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({ phase: "completed" }));

    await expect(publishPostgreSqlBackend({
      homeDir: "/private/home",
      packageRoot: "/opt/lcm",
      publicationId: "certification-test",
    }, {
      captureSource: () => source,
      createCoordinator: () => ({ prepare, resume }),
    })).resolves.toEqual({ phase: "completed" });

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "certification-test",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      projects: [],
      material: expect.objectContaining({
        source,
        target: expect.objectContaining({ projectMap: source.projectMap }),
      }),
    }));
    const target = prepare.mock.calls[0][0].material.target.config;
    expect(JSON.parse(target.content.toString("utf8"))).toEqual({
      storage: { postgresql: { poolMax: 2 }, backend: "postgresql" },
    });
    expect(target.mode).toBe(0o600);
  });
});
