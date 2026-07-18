import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLcmConfig } from "../../src/db/config.js";

describe("resolveLcmConfig", () => {
  it("returns every documented default", () => {
    expect(resolveLcmConfig({})).toEqual({
      enabled: true,
      databasePath: join(homedir(), ".claude", "lcm.db"),
      contextThreshold: 0.75,
      freshTailCount: 32,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20000,
      leafTargetTokens: 1200,
      condensedTargetTokens: 2000,
      maxExpandTokens: 4000,
      largeFileTokenThreshold: 25000,
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      autocompactDisabled: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pruneHeartbeatOk: false,
    });
  });

  it("coerces plugin configuration values", () => {
    expect(resolveLcmConfig({}, {
      enabled: false,
      dbPath: "  /plugin/lcm.db  ",
      contextThreshold: "0.5",
      freshTailCount: 12,
      leafMinFanout: "6",
      condensedMinFanout: 3,
      condensedMinFanoutHard: "1",
      incrementalMaxDepth: 5,
      leafChunkTokens: "10000",
      leafTargetTokens: 600,
      condensedTargetTokens: "900",
      maxExpandTokens: 2500,
      largeFileThresholdTokens: "18000",
      largeFileSummaryProvider: "  openai  ",
      largeFileSummaryModel: "  model-a  ",
      autocompactDisabled: true,
      timezone: "  UTC  ",
      pruneHeartbeatOk: true,
    })).toEqual({
      enabled: false,
      databasePath: "/plugin/lcm.db",
      contextThreshold: 0.5,
      freshTailCount: 12,
      leafMinFanout: 6,
      condensedMinFanout: 3,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 5,
      leafChunkTokens: 10000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 2500,
      largeFileTokenThreshold: 18000,
      largeFileSummaryProvider: "openai",
      largeFileSummaryModel: "model-a",
      autocompactDisabled: true,
      timezone: "UTC",
      pruneHeartbeatOk: true,
    });
    expect(resolveLcmConfig({}, { enabled: "true" }).enabled).toBe(true);
  });

  it("gives environment variables precedence over plugin configuration", () => {
    const env: NodeJS.ProcessEnv = {
      LCM_ENABLED: "false",
      LCM_DATABASE_PATH: "/env/lcm.db",
      LCM_CONTEXT_THRESHOLD: "0.9",
      LCM_FRESH_TAIL_COUNT: "41",
      LCM_LEAF_MIN_FANOUT: "11",
      LCM_CONDENSED_MIN_FANOUT: "7",
      LCM_CONDENSED_MIN_FANOUT_HARD: "3",
      LCM_INCREMENTAL_MAX_DEPTH: "9",
      LCM_LEAF_CHUNK_TOKENS: "30000",
      LCM_LEAF_TARGET_TOKENS: "1500",
      LCM_CONDENSED_TARGET_TOKENS: "2200",
      LCM_MAX_EXPAND_TOKENS: "5000",
      LCM_LARGE_FILE_TOKEN_THRESHOLD: "40000",
      LCM_LARGE_FILE_SUMMARY_PROVIDER: " anthropic ",
      LCM_LARGE_FILE_SUMMARY_MODEL: " claude-test ",
      LCM_AUTOCOMPACT_DISABLED: "true",
      TZ: "America/Sao_Paulo",
      LCM_PRUNE_HEARTBEAT_OK: "true",
    };
    const plugin = Object.fromEntries([
      "enabled", "dbPath", "contextThreshold", "freshTailCount", "leafMinFanout",
      "condensedMinFanout", "condensedMinFanoutHard", "incrementalMaxDepth",
      "leafChunkTokens", "leafTargetTokens", "condensedTargetTokens", "maxExpandTokens",
      "largeFileThresholdTokens", "largeFileSummaryProvider", "largeFileSummaryModel",
      "autocompactDisabled", "timezone", "pruneHeartbeatOk",
    ].map((key) => [key, key === "enabled" ? true : "plugin-value"]));

    expect(resolveLcmConfig(env, plugin)).toEqual({
      enabled: false,
      databasePath: "/env/lcm.db",
      contextThreshold: 0.9,
      freshTailCount: 41,
      leafMinFanout: 11,
      condensedMinFanout: 7,
      condensedMinFanoutHard: 3,
      incrementalMaxDepth: 9,
      leafChunkTokens: 30000,
      leafTargetTokens: 1500,
      condensedTargetTokens: 2200,
      maxExpandTokens: 5000,
      largeFileTokenThreshold: 40000,
      largeFileSummaryProvider: "anthropic",
      largeFileSummaryModel: "claude-test",
      autocompactDisabled: true,
      timezone: "America/Sao_Paulo",
      pruneHeartbeatOk: true,
    });
  });

  it("falls through invalid and empty plugin values to aliases and defaults", () => {
    const config = resolveLcmConfig({}, {
      enabled: "false",
      dbPath: "  ",
      databasePath: " /alias/lcm.db ",
      contextThreshold: Number.POSITIVE_INFINITY,
      freshTailCount: "not-a-number",
      leafMinFanout: null,
      condensedMinFanout: false,
      condensedMinFanoutHard: {},
      incrementalMaxDepth: Number.NaN,
      leafChunkTokens: "Infinity",
      leafTargetTokens: "",
      condensedTargetTokens: [],
      maxExpandTokens: undefined,
      largeFileThresholdTokens: "invalid",
      largeFileTokenThreshold: "19000",
      largeFileSummaryProvider: " ",
      largeFileSummaryModel: 42,
      autocompactDisabled: "false",
      timezone: "",
      pruneHeartbeatOk: "false",
    });

    expect(config).toMatchObject({
      enabled: false,
      databasePath: "/alias/lcm.db",
      contextThreshold: 0.75,
      freshTailCount: 32,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20000,
      leafTargetTokens: 0,
      condensedTargetTokens: 2000,
      maxExpandTokens: 4000,
      largeFileTokenThreshold: 19000,
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      autocompactDisabled: false,
      pruneHeartbeatOk: false,
    });
  });

  it("preserves the legacy environment parsing semantics", () => {
    const config = resolveLcmConfig({
      LCM_ENABLED: "0",
      LCM_DATABASE_PATH: "",
      LCM_CONTEXT_THRESHOLD: "invalid",
      LCM_AUTOCOMPACT_DISABLED: "false",
      LCM_PRUNE_HEARTBEAT_OK: "false",
      LCM_LARGE_FILE_SUMMARY_PROVIDER: "   ",
      LCM_LARGE_FILE_SUMMARY_MODEL: " model ",
      TZ: "",
    });

    expect(config.enabled).toBe(true);
    expect(config.databasePath).toBe("");
    expect(config.contextThreshold).toBeNaN();
    expect(config.autocompactDisabled).toBe(false);
    expect(config.pruneHeartbeatOk).toBe(false);
    expect(config.largeFileSummaryProvider).toBe("");
    expect(config.largeFileSummaryModel).toBe("model");
    expect(config.timezone).toBe("");
  });
});
