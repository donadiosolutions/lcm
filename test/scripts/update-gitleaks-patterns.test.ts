import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeGitleaksHostnameLiterals,
  verifyGitleaksSource,
} from "../../scripts/update-gitleaks-patterns.js";

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

describe("Gitleaks hostname normalization", () => {
  it("escapes only the Sidekiq host literals", () => {
    expect(normalizeGitleaksHostnameLiterals(
      "sidekiq-sensitive-url",
      "(?:gems.contribsys.com|enterprise.contribsys.com)",
    )).toBe("(?:gems\\.contribsys\\.com|enterprise\\.contribsys\\.com)");
  });

  it("escapes only the Slack webhook host literal", () => {
    expect(normalizeGitleaksHostnameLiterals(
      "slack-webhook-url",
      "hooks.slack.com/(?:services|workflows|triggers)",
    )).toBe("hooks\\.slack\\.com/(?:services|workflows|triggers)");
  });

  it("is idempotent for already escaped upstream hostnames", () => {
    const sidekiq = "(?:gems\\.contribsys\\.com|enterprise\\.contribsys\\.com)";
    const slack = "hooks\\.slack\\.com/services";
    expect(normalizeGitleaksHostnameLiterals("sidekiq-sensitive-url", sidekiq))
      .toBe(sidekiq);
    expect(normalizeGitleaksHostnameLiterals("slack-webhook-url", slack)).toBe(slack);
  });

  it("leaves unrelated rules and load-bearing dots byte-identical", () => {
    const rotatingSlack = "xoxe.xox[bp]-\\d-[A-Z0-9]{163,166}";
    const mailchimp = "(?:MailchimpSDK.initialize|mailchimp)";
    const conversions = "[A-Za-z0-9]+$start[\\s\\S](?:token)";

    expect(normalizeGitleaksHostnameLiterals("unrelated-rule", "hooks.slack.com"))
      .toBe("hooks.slack.com");
    expect(normalizeGitleaksHostnameLiterals(
      "slack-config-access-token",
      rotatingSlack,
    )).toBe(rotatingSlack);
    expect(normalizeGitleaksHostnameLiterals("mailchimp-api-key", mailchimp))
      .toBe(mailchimp);
    expect(normalizeGitleaksHostnameLiterals("sidekiq-sensitive-url", conversions))
      .toBe(conversions);
  });
});
