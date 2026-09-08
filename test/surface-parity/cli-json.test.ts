import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { json } from "../postgresql/fixtures/surface-parity-identity.mjs";

const privateText = "/private/fixture postgres://private-user:private-password@private-host/db";

it.each([
  ["publication-busy", "", `LCM storage publication is busy. ${privateText}`],
  ["migration-busy", "", `LCM home migration is busy. ${privateText}`],
  ["daemon-unavailable", "", `lcm daemon unavailable (ambiguous); ${privateText}`],
  ["command-failed", "", `LCM command failed. ${privateText}`],
  ["incomplete", JSON.stringify({ incomplete: true, privateText }), ""],
  ["result-errors", JSON.stringify({ errors: 1, privateText }), ""],
  ["stored-data", JSON.stringify({ error: `already a project with stored data ${privateText}` }), ""],
  ["unexpected-status", privateText, privateText],
  ["unexpected-status", JSON.stringify({ errors: 0, incomplete: false, privateText }), ""],
])("classifies %s without exposing captured CLI output", (category, stdout, stderr) => {
  let failure: (Error & { surfaceEvidence: { stderrDigest: string } }) | undefined;
  try { json({ code: 1, stdout, stderr }); }
  catch (error) { failure = error as typeof failure; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure!.message).toMatch(new RegExp(`^surface-identity:cli-L(?:[0-9]+|unknown):${category}$`, "u"));
  expect(failure!.surfaceEvidence).toEqual({
    stderrDigest: createHash("sha256").update(stderr).digest("hex"),
  });
  expect(JSON.stringify(failure)).not.toContain(privateText);
  expect(failure!.stack).not.toContain(privateText);
});

it("preserves success payloads and explicitly expected nonzero results", () => {
  const payload = { errors: 0, promoted: 0 };
  expect(json({ code: 0, stdout: JSON.stringify(payload), stderr: "" })).toEqual(payload);
  expect(json({ code: 1, stdout: JSON.stringify(payload), stderr: "" }, 1)).toEqual(payload);
});

it("still rejects malformed JSON on an otherwise successful command", () => {
  expect(() => json({ code: 0, stdout: "not-json", stderr: "" })).toThrow(SyntaxError);
});
