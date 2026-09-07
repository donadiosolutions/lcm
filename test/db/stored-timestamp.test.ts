import { describe, expect, it } from "vitest";
import { parseStoredTimestamp } from "../../src/db/stored-timestamp.js";

describe("parseStoredTimestamp", () => {
  it("interprets SQLite timestamps as UTC", () => {
    expect(parseStoredTimestamp("2024-03-10 02:30:00").toISOString())
      .toBe("2024-03-10T02:30:00.000Z");
  });

  it("preserves fractional seconds through millisecond precision", () => {
    expect(parseStoredTimestamp("2024-03-10 02:30:00.123456").toISOString())
      .toBe("2024-03-10T02:30:00.123Z");
  });

  it("preserves qualified timestamps", () => {
    expect(parseStoredTimestamp("2024-03-10T02:30:00Z").toISOString())
      .toBe("2024-03-10T02:30:00.000Z");
    expect(parseStoredTimestamp("2024-03-10T02:30:00+02:00").toISOString())
      .toBe("2024-03-10T00:30:00.000Z");
  });

  it("keeps T timestamps without an offset in the host-local interpretation", () => {
    const parsed = parseStoredTimestamp("2024-03-10T02:30:00");
    expect(parsed.getTime()).toBe(Date.parse("2024-03-10T02:30:00"));
  });

  it("returns Invalid Date for malformed values", () => {
    expect(Number.isNaN(parseStoredTimestamp("not-a-date").getTime())).toBe(true);
    expect(Number.isNaN(parseStoredTimestamp("9999-12-31 99:99:99").getTime())).toBe(true);
    expect(Number.isNaN(parseStoredTimestamp("").getTime())).toBe(true);
  });
});
