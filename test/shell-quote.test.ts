import { describe, expect, it } from "vitest";
import { quoteShellArgument } from "../src/shell-quote.js";

describe("shell argument quoting", () => {
  it.each([
    ["", "''"],
    ["plain", "'plain'"],
    ["two words", "'two words'"],
    ["--leading-option", "'--leading-option'"],
    ["`command` $(subshell) $HOME", "'`command` $(subshell) $HOME'"],
    ["it's quoted", "'it'\"'\"'s quoted'"],
  ])("quotes POSIX argument %j", (value, expected) => {
    expect(quoteShellArgument(value, "linux")).toBe(expected);
  });

  it("quotes PowerShell apostrophes without interpreting metacharacters", () => {
    expect(quoteShellArgument("it's `$(literal)`", "win32"))
      .toBe("'it''s `$(literal)`'");
  });
});
