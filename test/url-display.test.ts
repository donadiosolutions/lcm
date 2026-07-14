import { describe, expect, it } from "vitest";
import {
  sanitizeEmbeddedUrlValuesForDisplay,
  sanitizeUrlValueForDisplay,
} from "../src/url-display.js";

describe("URL display sanitization", () => {
  it("redacts absolute non-HTTP connection URIs", () => {
    expect(sanitizeUrlValueForDisplay(
      "postgres://database-user:database-password@db.example.com/app",
      "dsn",
    )).toBe("[REDACTED]");
    expect(sanitizeUrlValueForDisplay(
      "mongodb+srv://database-user:database-password@cluster.example.com/app",
    )).toBe("[REDACTED]");
  });

  it("sanitizes embedded URIs and connection-secret assignments", () => {
    const value = [
      "primary=postgres://db-user:db-password@db.example.com/app;",
      "fallback=https://web-user:web-password@example.com/v1?token=query-secret#fragment-secret;",
      "secondary=//proxy-user:proxy-password@proxy.example.com/v1?token=proxy-token;",
      "Server=db;User Id=connection-user;Password=connection-password;Database=app",
    ].join(" ");

    const sanitized = sanitizeEmbeddedUrlValuesForDisplay(value);
    for (const secret of [
      "db-user", "db-password", "web-user", "web-password", "query-secret", "fragment-secret",
      "connection-user", "connection-password",
      "proxy-user", "proxy-password", "proxy-token",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).toContain("primary=[REDACTED];");
    expect(sanitized).toContain("fallback=https://example.com/v1?[REDACTED]#[REDACTED];");
    expect(sanitized).toContain("secondary=//proxy.example.com/v1?[REDACTED];");
    expect(sanitized).toContain("User Id=[REDACTED]");
    expect(sanitized).toContain("Password=[REDACTED]");
  });

  it("does not alter ordinary non-URL strings", () => {
    const value = "ordinary label with count=3, model=alpha, // operator, and /tmp/cache//segments";
    expect(sanitizeUrlValueForDisplay(value, "description")).toBe(value);
  });

  it("redacts common abbreviated and quoted connection credentials", () => {
    const value = "Driver=postgres;UID=connection-user;PWD=\"connection-password\";api_key='api-secret'";
    expect(sanitizeEmbeddedUrlValuesForDisplay(value)).toBe(
      "Driver=postgres;UID=[REDACTED];PWD=[REDACTED];api_key=[REDACTED]",
    );
  });

  it("fully redacts brace-delimited ODBC credentials", () => {
    const value = "Driver=ODBC Driver;Server=db;Password={p;ass}}word};Database=app";
    expect(sanitizeEmbeddedUrlValuesForDisplay(value)).toBe(
      "Driver=ODBC Driver;Server=db;Password=[REDACTED];Database=app",
    );
  });
});
