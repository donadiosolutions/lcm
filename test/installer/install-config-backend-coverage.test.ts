import { describe, expect, it, vi } from "vitest";

const publicationMock = vi.hoisted(() => ({
  backendPublicationHomeForConfigPath: vi.fn(() => "/tmp/lcm-publication-home"),
  withBackendPublicationConfigLock: vi.fn((_: string, callback: (token: object) => unknown) => callback({})),
  assertBackendPublicationConfigAccess: vi.fn(),
  assertBackendPublicationConsumerAccess: vi.fn(),
  assertBackendPublicationConfigMutation: vi.fn(),
}));

vi.mock("../../src/storage/backend-publication.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/storage/backend-publication.js")>(
    "../../src/storage/backend-publication.js",
  );
  return { ...actual, ...publicationMock };
});

import { prepareInstallConfig, type ServiceDeps } from "../../installer/install.js";

describe("installer backend selection coverage", () => {
  it("passes both SQLite and PostgreSQL stored backends through the publication lock seam", () => {
    const makeDeps = (content: string): ServiceDeps => ({
      spawnSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(content),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(true),
      ensureLcmHome: vi.fn(),
      promptUser: vi.fn(),
    });

    expect(prepareInstallConfig(makeDeps("{}"), "/tmp/lcm/.lcm/config.json")).toEqual({
      exists: true,
      content: "{}",
    });
    expect(prepareInstallConfig(
      makeDeps('{"storage":{"backend":"postgresql"}}'),
      "/tmp/lcm/.lcm/config.json",
    )).toEqual({
      exists: true,
      content: '{"storage":{"backend":"postgresql"}}',
    });
    expect(publicationMock.assertBackendPublicationConfigAccess).toHaveBeenCalledWith(
      "/tmp/lcm/.lcm/config.json",
      "postgresql",
      '{"storage":{"backend":"postgresql"}}',
      undefined,
      expect.any(Object),
    );
  });
});
