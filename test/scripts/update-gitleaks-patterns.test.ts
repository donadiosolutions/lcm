import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeRequiredKeywords,
  collapseRedundantLazyPrefixes,
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

  it("normalizes a raw Slack webhook host literal to paired case", () => {
    expect(normalizeGitleaksHostnameLiterals(
      "slack-webhook-url",
      "hooks.slack.com/services",
    )).toBe("[Hh][Oo][Oo][Kk][Ss]\\.[Ss][Ll][Aa][Cc][Kk]\\.[Cc][Oo][Mm]/services");
  });

  it("normalizes an escaped Slack webhook host literal to the same paired output", () => {
    expect(normalizeGitleaksHostnameLiterals(
      "slack-webhook-url",
      "hooks\\.slack\\.com/services",
    )).toBe("[Hh][Oo][Oo][Kk][Ss]\\.[Ss][Ll][Aa][Cc][Kk]\\.[Cc][Oo][Mm]/services");
  });

  it("leaves escaped Sidekiq hostnames byte-identical", () => {
    const sidekiq = "(?:gems\\.contribsys\\.com|enterprise\\.contribsys\\.com)";
    expect(normalizeGitleaksHostnameLiterals("sidekiq-sensitive-url", sidekiq))
      .toBe(sidekiq);
  });

  it("leaves already paired Slack hostnames byte-identical", () => {
    const slack = "[Hh][Oo][Oo][Kk][Ss]\\.[Ss][Ll][Aa][Cc][Kk]\\.[Cc][Oo][Mm]/services";
    expect(normalizeGitleaksHostnameLiterals("slack-webhook-url", slack)).toBe(slack);
  });

  it("leaves unrelated rules and suffixes byte-identical", () => {
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

describe("Gitleaks redundant lazy prefix collapse", () => {
  it("collapses a nested same-class lazy prefix into one bounded quantifier", () => {
    expect(collapseRedundantLazyPrefixes(
      "[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:meraki)(?:[ \\t\\w.-]{0,20}))(?:=)([0-9a-f]{40})",
    )).toBe("[\\w.-]{0,100}?(?:(?:meraki)(?:[ \\t\\w.-]{0,20}))(?:=)([0-9a-f]{40})");
  });

  it("leaves a single lazy prefix byte-identical", () => {
    const single = "[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}";
    expect(collapseRedundantLazyPrefixes(single)).toBe(single);
  });

  it("leaves nested prefixes over different character classes byte-identical", () => {
    const mixed = "[\\w.-]{0,50}?(?:[ \\t\\w.-]{0,50}?(?:okta))";
    expect(collapseRedundantLazyPrefixes(mixed)).toBe(mixed);
  });

  it("leaves greedy nested prefixes byte-identical", () => {
    const greedy = "[\\w.-]{0,50}(?:[\\w.-]{0,50}(?:okta))";
    expect(collapseRedundantLazyPrefixes(greedy)).toBe(greedy);
  });
});

describe("Gitleaks required-keyword analysis", () => {
  it("proves mandatory literals, folded classes, and covered alternatives", () => {
    expect(analyzeRequiredKeywords("prefixMERAKIsuffix", ["meraki"], "")).toEqual({
      verified: true,
      reason: null,
    });
    expect(analyzeRequiredKeywords("[Mm]eraki", ["meraki"], "")).toEqual({
      verified: true,
      reason: null,
    });
    expect(analyzeRequiredKeywords("xox[pe]-[A-Z]+", ["xox"], "")).toEqual({
      verified: true,
      reason: null,
    });
    expect(analyzeRequiredKeywords("(?:cohere|CO_API_KEY)[ :=]+", [
      "cohere",
      "co_api_key",
    ], "")).toEqual({ verified: true, reason: null });
  });

  it("always compares prefilter keywords case-insensitively", () => {
    expect(analyzeRequiredKeywords("MERAKI", ["meraki"], "")).toEqual({
      verified: true,
      reason: null,
    });
  });

  it("preserves proof through positive bounded and unbounded repetition", () => {
    expect(analyzeRequiredKeywords("(?:meraki)+", ["meraki"], "").verified)
      .toBe(true);
    expect(analyzeRequiredKeywords("(?:meraki){2,}", ["meraki"], "").verified)
      .toBe(true);
  });

  it("refuses optional and zero-minimum keyword occurrences", () => {
    expect(analyzeRequiredKeywords("(?:meraki)?token", ["meraki"], "").verified)
      .toBe(false);
    expect(analyzeRequiredKeywords("(?:meraki)*token", ["meraki"], "").verified)
      .toBe(false);
    expect(analyzeRequiredKeywords("(?:meraki){0,2}token", ["meraki"], "").verified)
      .toBe(false);
  });

  it("requires every alternation arm to contain an admitted keyword", () => {
    expect(analyzeRequiredKeywords("(?:meraki|other)", ["meraki"], "").verified)
      .toBe(false);
    expect(analyzeRequiredKeywords("(?:cohere|CO_API_KEY)", ["cohere"], "").verified)
      .toBe(false);
  });

  it("fails closed on unsupported regex constructs", () => {
    expect(analyzeRequiredKeywords("(?=meraki)meraki", ["meraki"], ""))
      .toEqual({
        verified: false,
        reason: "unsupported group construct at offset 0",
      });
  });
});
