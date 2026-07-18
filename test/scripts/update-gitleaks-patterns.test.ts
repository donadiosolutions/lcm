import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitleaksSource } from "../../scripts/update-gitleaks-patterns.js";

describe("Gitleaks update source integrity", () => {
  it("accepts content matching the pinned digest", () => {
    const content = "trusted gitleaks configuration";
    const digest = createHash("sha256").update(content).digest("hex");
    expect(() => verifyGitleaksSource(content, digest)).not.toThrow();
  });

  it("rejects modified content before it can be generated into source", () => {
    const trustedDigest = createHash("sha256").update("trusted").digest("hex");
    expect(() => verifyGitleaksSource("attacker-controlled", trustedDigest))
      .toThrow(/Gitleaks source checksum mismatch/);
  });
});
