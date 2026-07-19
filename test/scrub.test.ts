import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getGitleaksSyncDate,
  normalizeGitleaksRegex,
  ScrubEngine,
} from "../src/scrub.js";

describe("ScrubEngine — built-in patterns", () => {
  const engine = new ScrubEngine([], []);

  it("redacts OpenAI keys (sk-...)", () => {
    expect(engine.scrub("key=sk-abcdefghijklmnopqrstu")).toContain("[REDACTED]");
  });

  it("redacts Anthropic keys (sk-ant-...)", () => {
    expect(engine.scrub("key=sk-ant-api03-" + "a".repeat(40))).toContain("[REDACTED]");
  });

  it("redacts GitHub PATs (ghp_...)", () => {
    expect(engine.scrub("token=ghp_" + "A".repeat(36))).toContain("[REDACTED]");
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    expect(engine.scrub("aws_access_key_id=AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(engine.scrub("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9")).toContain("[REDACTED]");
  });

  it("redacts PEM key headers", () => {
    expect(engine.scrub("-----BEGIN RSA KEY-----")).toContain("[REDACTED]");
  });

  it("does not redact normal text", () => {
    const text = "Hello world, this is safe content.";
    expect(engine.scrub(text)).toBe(text);
  });

  it("redacts npm tokens (npm_...)", () => {
    expect(engine.scrub("token=npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")).toContain("[REDACTED]");
  });

  it("redacts Slack bot tokens (xoxb-...)", () => {
    expect(engine.scrub("SLACK_TOKEN=xoxb-123456789-abcdefghij")).toContain("[REDACTED]");
  });

  it("redacts Slack user tokens (xoxp-...)", () => {
    expect(engine.scrub("token=xoxp-999888777-abcdef")).toContain("[REDACTED]");
  });

  it("redacts Slack rotating tokens (xoxe-...)", () => {
    expect(engine.scrub("token=xoxe-1-abc123def456")).toContain("[REDACTED]");
  });

  it("redacts Slack app-level tokens (xapp-...)", () => {
    expect(engine.scrub("token=xapp-1-A0B1C2D3E4F-abc123")).toContain("[REDACTED]");
  });

  it("redacts Slack workflow tokens (xwfp-...)", () => {
    expect(engine.scrub("token=xwfp-abc123-def456")).toContain("[REDACTED]");
  });

  it("redacts Stripe live secret keys (sk_live_...)", () => {
    expect(engine.scrub("key=sk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
  });

  it("redacts Stripe live publishable keys (pk_live_...)", () => {
    expect(engine.scrub("key=pk_live_51J3kxABCDEFghijKLMNop")).toContain("[REDACTED]");
  });

  it("redacts Google/GCP API keys (AIza...)", () => {
    expect(engine.scrub("key=AIzaSyA1234567890abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
  });

  it("redacts SendGrid API tokens (SG.…)", () => {
    expect(engine.scrub("SENDGRID_KEY=SG." + "a".repeat(66))).toContain("[REDACTED]");
  });

  it("redacts Twilio API keys (SK...)", () => {
    expect(engine.scrub("TWILIO_KEY=SK00000000000000000000000000000000")).toContain("[REDACTED]");
  });

  it("redacts Shopify access tokens (shpat_...)", () => {
    expect(engine.scrub("token=shpat_" + "a".repeat(32))).toContain("[REDACTED]");
  });

  it("redacts Vault service tokens (hvs.…)", () => {
    expect(engine.scrub("VAULT_TOKEN=hvs." + "a".repeat(95))).toContain("[REDACTED]");
  });

  it("redacts Doppler API tokens (dp.pt.…)", () => {
    expect(engine.scrub("DOPPLER=dp.pt." + "a".repeat(43))).toContain("[REDACTED]");
  });

  it("redacts database connection strings with credentials", () => {
    expect(engine.scrub("DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb")).toContain("[REDACTED]");
    expect(engine.scrub("MONGO=mongodb://root:pass@mongo:27017/app")).toContain("[REDACTED]");
    expect(engine.scrub("REDIS=redis://default:hunter2@redis.example.com:6379")).toContain("[REDACTED]");
    expect(engine.scrub("REDIS=redis://:hunter2@redis.example.com:6379/0")).toContain("[REDACTED]");
    expect(engine.scrub("REDISS=rediss://:hunter2@redis.example.com:6379/0")).toContain("[REDACTED]");
  });

  it("redacts JWTs (eyJ... three-segment tokens)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aBcDeFgHiJkLmNoPqRsTuVwXyZ";
    expect(engine.scrub(`token=${jwt}`)).toContain("[REDACTED]");
  });

  it("does not redact partial JWT-like strings without dots", () => {
    expect(engine.scrub("eyJhbGciOiJIUzI1NiJ9")).not.toContain("[REDACTED]");
  });
});

describe("Gitleaks RE2 normalization", () => {
  it("converts POSIX classes, end anchors, and scoped case flags", () => {
    expect(normalizeGitleaksRegex("pat[[:alnum:]]+\\z", "")).toEqual({
      source: "pat[A-Za-z0-9]+$",
      flags: "",
    });
    const scoped = normalizeGitleaksRegex("(?i:token)-(?-i:ABC)", "");
    expect(scoped).toEqual({ source: "(?:token)-(?:ABC)", flags: "i" });
    expect(new RegExp(scoped.source, scoped.flags).test("TOKEN-abc")).toBe(true);
  });

  it("redacts long database URLs without catastrophic backtracking", () => {
    const engine = new ScrubEngine([], []);
    const secret = `postgres://user:${"p".repeat(20_000)}@db.example/app`;
    expect(engine.scrub(secret)).toBe("[REDACTED]/app");
    expect(engine.scrub(`postgres://user:${"p".repeat(20_000)}`)).toContain("postgres://");
  });
});

describe("ScrubEngine — custom patterns", () => {
  it("applies user-defined global patterns", () => {
    const engine = new ScrubEngine(["MY_TOKEN_[A-Z0-9]+"], []);
    expect(engine.scrub("token=MY_TOKEN_ABC123")).toContain("[REDACTED]");
  });

  it("applies per-project patterns", () => {
    const engine = new ScrubEngine([], ["PROJ_SECRET_[A-Z]+"]);
    expect(engine.scrub("secret=PROJ_SECRET_XYZ")).toContain("[REDACTED]");
  });

  it("global patterns precede project patterns (merge order)", () => {
    const engine = new ScrubEngine(["GLOBAL_[A-Z0-9]+"], ["LOCAL_[A-Z0-9]+"]);
    expect(engine.scrub("GLOBAL_123 and LOCAL_456")).toBe("[REDACTED] and [REDACTED]");
  });

  it("warns and skips invalid regex patterns, continues scrubbing valid ones", () => {
    const engine = new ScrubEngine(["[invalid"], ["VALID_[A-Z]+"]);
    expect(engine.scrub("VALID_ABC")).toContain("[REDACTED]");
    expect(engine.invalidPatterns).toContain("[invalid");
  });

  it("fully redacts consuming escaped-dot and spanning patterns", () => {
    const engine = new ScrubEngine(["literal\\.value", "SPAN."], []);
    const result = engine.scrubWithCounts("literal.value SPANx");
    expect(result.text).toBe("[REDACTED] [REDACTED]");
    expect(result.text).not.toContain("literal.value");
    expect(result.text).not.toContain("SPANx");
    expect(result.global).toBe(2);
  });

  it("fully redacts zero-length token and spanning matches (issue #115)", () => {
    const engine = new ScrubEngine(["(?=TOKEN)", "(?=SPAN.)"], []);
    const result = engine.scrubWithCounts("TOKEN SPANx");

    expect(result.global).toBe(2);
    expect(result.text).toBe("[REDACTED] [REDACTED]");
    expect(result.text).not.toContain("TOKEN");
    expect(result.text).not.toContain("SPANx");
  });

  it("expands zero-length matches to the complete token at each boundary", () => {
    expect(new ScrubEngine(["(?=KEN)"], []).scrubWithCounts("TOKEN")).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
    expect(new ScrubEngine(["$"], []).scrubWithCounts("TOKEN")).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
    expect(new ScrubEngine(["(?=\\s)"], []).scrubWithCounts("  TOKEN")).toEqual({
      text: "  [REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("does not report zero-length redactions when no token can be consumed", () => {
    const spanning = new ScrubEngine(["(?=\\s)"], []).scrubWithCounts("  ");
    const token = new ScrubEngine(["(?=)"], []).scrubWithCounts("");

    expect(spanning).toEqual({ text: "  ", gitleaks: 0, builtIn: 0, global: 0, project: 0 });
    expect(token).toEqual({ text: "", gitleaks: 0, builtIn: 0, global: 0, project: 0 });
  });

  it("redacts the following token for a zero-width lookahead on whitespace", () => {
    const result = new ScrubEngine(["(?=\\s+SECRET_[A-Z]+)"], [])
      .scrubWithCounts("safe SECRET_VALUE");

    expect(result).toEqual({
      text: "safe [REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("redacts the preceding token for a zero-width lookbehind at its end boundary", () => {
    const result = new ScrubEngine(["(?<=SECRET)(?=\\s)"], [])
      .scrubWithCounts("SECRET NEXT");

    expect(result).toEqual({
      text: "[REDACTED] NEXT", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("fails closed when a lookbehind consumes the separator before its anchor", () => {
    const result = new ScrubEngine(["(?<=SECRET\\s)"], [])
      .scrubWithCounts("SECRET NEXT");

    expect(result).toEqual({
      text: "[REDACTED] [REDACTED]", gitleaks: 0, builtIn: 0, global: 2, project: 0,
    });
    expect(result.text).not.toContain("SECRET");
  });

  it("redacts both plausible tokens when mixed assertions make direction ambiguous", () => {
    for (const pattern of [
      "(?:(?<=X)(?=Y)|(?=\\s+SECRET_[A-Z]+))",
      "(?<=safe)(?=(?:\\s+SECRET_[A-Z]+))",
    ]) {
      const result = new ScrubEngine([pattern], []).scrubWithCounts("safe SECRET_VALUE");

      expect(result).toEqual({
        text: "[REDACTED] [REDACTED]", gitleaks: 0, builtIn: 0, global: 2, project: 0,
      });
      expect(result.text).not.toContain("SECRET_VALUE");
    }
  });

  it("fails closed when lookahead probes depend on lookbehind captures", () => {
    for (const pattern of [
      "(?<=(?<value>safe))(?=\\s+\\k<value>)",
      "(?<=(safe))(?=\\s+\\1)",
    ]) {
      const result = new ScrubEngine([pattern], []).scrubWithCounts("safe safe");

      expect(result).toEqual({
        text: "[REDACTED] [REDACTED]", gitleaks: 0, builtIn: 0, global: 2, project: 0,
      });
    }
  });

  it("fails closed when detached lookahead probes contain nested lookbehind", () => {
    for (const pattern of [
      "(?=(?<=safe)\\s+SECRET_[A-Z]+)",
      "(?=(?<!unsafe)\\s+SECRET_[A-Z]+)",
    ]) {
      const result = new ScrubEngine([pattern], []).scrubWithCounts("safe SECRET_VALUE");

      expect(result).toEqual({
        text: "[REDACTED] [REDACTED]", gitleaks: 0, builtIn: 0, global: 2, project: 0,
      });
      expect(result.text).not.toContain("SECRET_VALUE");
    }
  });

  it("does not detach capture-dependent consuming alternatives", () => {
    const result = new ScrubEngine(["(?=SECRET)|(?<value>SECRET)\\s+\\k<value>"], [])
      .scrubWithCounts("SECRET SECRET tail");

    expect(result).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("analyzes negative lookbehinds and incomplete quantifier-like literals", () => {
    const result = new ScrubEngine(["(?<!X)(?=TOKEN)", "A{2"], [])
      .scrubWithCounts("TOKEN A{2");

    expect(result).toEqual({
      text: "[REDACTED] [REDACTED]", gitleaks: 0, builtIn: 0, global: 2, project: 0,
    });
  });

  it("ignores lookbehind-like text inside a character class when choosing direction", () => {
    const result = new ScrubEngine([
      "(?=[(?<=])|(?=\\s+SECRET_[A-Z]+)",
    ], []).scrubWithCounts("safe SECRET_VALUE");

    expect(result).toEqual({
      text: "safe [REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("preserves consuming alternatives after expanding a zero-width match", () => {
    const result = new ScrubEngine(["(?=SAFE)|SECRET\\s+VALUE"], [])
      .scrubWithCounts("SAFESECRET VALUE");

    expect(result).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
    expect(result.text).not.toContain("VALUE");
  });

  it("evaluates consuming alternatives hidden by a zero-width match at the same anchor", () => {
    const result = new ScrubEngine(["(?=SECRET)|SECRET\\s+VALUE"], [])
      .scrubWithCounts("SECRET VALUE");

    expect(result).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
    expect(result.text).not.toContain("VALUE");
  });

  it("continues within an expanded token when its consuming alternative does not match", () => {
    const result = new ScrubEngine(["(?=SAFE)|SECRET\\s+VALUE"], [])
      .scrubWithCounts("SAFE OTHER");

    expect(result).toEqual({
      text: "[REDACTED] OTHER", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("does not execute detached lookahead probes for consuming matches", () => {
    const engine = new ScrubEngine(["(?<=X)(?=Y)|SECRET"], []);
    const originalExec = RegExp.prototype.exec;
    let lookaheadProbeCalls = 0;
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      value: string,
    ): RegExpExecArray | null {
      if (this.source === "^(?:Y)") lookaheadProbeCalls++;
      return originalExec.call(this, value);
    });

    try {
      expect(engine.scrub("SECRET")).toBe("[REDACTED]");
    } finally {
      execSpy.mockRestore();
    }
    expect(lookaheadProbeCalls).toBe(0);
  });

  it("bounds wrapped and otherwise unprobeable mixed alternatives", () => {
    const token = "A".repeat(16_384);
    const patterns = [
      "(?:(?=.)|CONSUMING)",
      "(?:(?=.)|CONSUMING)X?",
    ];
    const engine = new ScrubEngine(patterns, []);
    const originalExec = RegExp.prototype.exec;
    const execCounts = new Map<string, number>();
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      value: string,
    ): RegExpExecArray | null {
      if (patterns.includes(this.source)) {
        execCounts.set(this.source, (execCounts.get(this.source) ?? 0) + 1);
      }
      return originalExec.call(this, value);
    });

    try {
      expect(engine.scrub(token)).toBe("[REDACTED]");
    } finally {
      execSpy.mockRestore();
    }
    for (const pattern of patterns) expect(execCounts.get(pattern)).toBeLessThanOrEqual(2);
  });

  it("handles long escaped regex sources without backtracking in syntax analysis", () => {
    const escapedBackslashes = "\\\\".repeat(8_192);
    const result = new ScrubEngine([
      `(?!${escapedBackslashes})A`,
      `(?=${escapedBackslashes})|A`,
    ], []).scrubWithCounts("A");

    expect(result).toEqual({
      text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("caches regex source analysis when patterns are constructed", () => {
    const startsWithSpy = vi.spyOn(String.prototype, "startsWith");
    const engine = new ScrubEngine(["(?=TOKEN)|SECRET\\s+VALUE"], []);
    startsWithSpy.mockClear();

    try {
      expect(engine.scrub("ordinary ".repeat(1_000))).toBe("ordinary ".repeat(1_000));
      expect(startsWithSpy).not.toHaveBeenCalled();
    } finally {
      startsWithSpy.mockRestore();
    }
  });

  it("skips regex execution for empty token segments at whitespace boundaries", () => {
    const engine = new ScrubEngine(["TOKEN"], []);
    const originalExec = RegExp.prototype.exec;
    let tokenPatternCalls = 0;
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      value: string,
    ): RegExpExecArray | null {
      if (this.source === "TOKEN") tokenPatternCalls++;
      return originalExec.call(this, value);
    });

    try {
      expect(engine.scrub(" TOKEN ")).toBe(" [REDACTED] ");
    } finally {
      execSpy.mockRestore();
    }
    expect(tokenPatternCalls).toBe(2);
  });

  it("falls back to the final preceding token from trailing whitespace", () => {
    expect(new ScrubEngine(["(?=\\s*$)"], []).scrubWithCounts("TOKEN  ")).toEqual({
      text: "[REDACTED]  ", gitleaks: 0, builtIn: 0, global: 1, project: 0,
    });
  });

  it("bounds repeated zero-width matching work for long tokens in both paths", () => {
    const token = "A".repeat(16_384);
    const engine = new ScrubEngine([
      "(?=.)", "(?=.)", "(?=A)", "(?=A)", "(?=A)|(?=B)", "(?=A)|(?=B)",
    ], []);
    const originalExec = RegExp.prototype.exec;
    const execCounts = new Map<string, number>();
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      value: string,
    ): RegExpExecArray | null {
      if (this.source === "(?=.)" || this.source === "(?=A)" || this.source === "(?=A)|(?=B)") {
        execCounts.set(this.source, (execCounts.get(this.source) ?? 0) + 1);
      }
      return originalExec.call(this, value);
    });

    try {
      expect(engine.scrubWithCounts(token)).toEqual({
        text: "[REDACTED]", gitleaks: 0, builtIn: 0, global: 1, project: 0,
      });
    } finally {
      execSpy.mockRestore();
    }

    expect(execCounts.get("(?=.)")).toBeLessThanOrEqual(4);
    expect(execCounts.get("(?=A)")).toBeLessThanOrEqual(4);
    expect(execCounts.get("(?=A)|(?=B)")).toBeLessThanOrEqual(4);
  });

  it("merges overlapping matches and preserves disjoint surrounding text", () => {
    const engine = new ScrubEngine(["SECRET_[A-Z]+", "SECRET_ALPHA"], []);
    expect(engine.scrub("before SECRET_ALPHA after")).toBe("before [REDACTED] after");
  });
});

describe("gitleaks metadata", () => {
  it("reports no generated sync date from an unbuilt source checkout", () => {
    expect(getGitleaksSyncDate()).toBeNull();
  });
});

describe("ScrubEngine.scrubWithCounts", () => {
  it("returns zero counts when nothing is redacted", () => {
    const engine = new ScrubEngine([], []);
    const result = engine.scrubWithCounts("Hello world, this is safe content.");
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toBe("Hello world, this is safe content.");
  });

  it("counts gitleaks pattern matches (GitHub PAT)", () => {
    const engine = new ScrubEngine([], []);
    // ghp_ GitHub PAT — covered by both gitleaks and native; gitleaks wins (lower index)
    const result = engine.scrubWithCounts("token=ghp_" + "A".repeat(36));
    expect(result.gitleaks).toBeGreaterThan(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts built-in (native) pattern matches for strings not covered by gitleaks", () => {
    const engine = new ScrubEngine([], []);
    // Database connection URL — only in NATIVE_PATTERNS, not gitleaks
    const result = engine.scrubWithCounts("postgres://admin:s3cret@db.example.com:5432/mydb");
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.gitleaks).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(0);
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts global pattern matches", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z0-9]+"], []);
    // XUNIT_ prefix doesn't appear in gitleaks or native patterns
    const result = engine.scrubWithCounts("XUNIT_ABC123");
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(0);
  });

  it("counts project pattern matches", () => {
    const engine = new ScrubEngine([], ["ZEBRA_[A-Z]+"]);
    // ZEBRA_ prefix doesn't appear in gitleaks or native patterns
    const result = engine.scrubWithCounts("ZEBRA_XYZ");
    expect(result.gitleaks).toBe(0);
    expect(result.builtIn).toBe(0);
    expect(result.global).toBe(0);
    expect(result.project).toBe(1);
  });

  it("counts multiple matches across categories independently", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z0-9]+"], ["ZEBRA_[A-Z]+"]);
    // XUNIT_ (global) + ZEBRA_ (project) + DB URL (native/builtIn)
    const result = engine.scrubWithCounts("XUNIT_123 and ZEBRA_XYZ and postgres://admin:s3cret@db.example.com/mydb");
    expect(result.builtIn).toBeGreaterThan(0);
    expect(result.global).toBe(1);
    expect(result.project).toBe(1);
  });

  it("scrub() returns same text as scrubWithCounts().text", () => {
    const engine = new ScrubEngine(["XUNIT_[A-Z]+"], ["ZEBRA_[A-Z]+"]);
    const text = "XUNIT_ABC ZEBRA_XYZ safe text";
    expect(engine.scrub(text)).toBe(engine.scrubWithCounts(text).text);
  });
});

describe("ScrubEngine.loadProjectPatterns", () => {
  let tmpFile: string | undefined;

  afterEach(async () => {
    if (tmpFile) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpFile, { force: true });
      tmpFile = undefined;
    }
  });

  it("parses patterns file, ignoring comment lines and blanks", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    tmpFile = join(tmpdir(), `scrub-test-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(tmpFile, "# comment\nMY_PAT\n\n# another comment\nSECRET_KEY\n");
    const patterns = await ScrubEngine.loadProjectPatterns(tmpFile);
    expect(patterns).toEqual(["MY_PAT", "SECRET_KEY"]);
  });

  it("returns empty array when file does not exist", async () => {
    const patterns = await ScrubEngine.loadProjectPatterns("/nonexistent/path.txt");
    expect(patterns).toEqual([]);
  });

  it("rethrows non-ENOENT errors", async () => {
    await expect(ScrubEngine.loadProjectPatterns("/")).rejects.toThrow();
  });
});
