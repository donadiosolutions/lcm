import { describe, expect, it } from "vitest";
import { hashProjectPath } from "../../src/project-map.js";
import { resolveDiagnosticProject } from "../../src/storage/diagnostic-project.js";

const hash = "a".repeat(64);
const remote = "019a6a82-6f70-7000-8000-000000000001";
const map = JSON.stringify({ [hash]: { canonical: "/diagnostic/project", aliases: ["/diagnostic/alias"], remoteProjectId: remote } });
describe("diagnostic project resolution", () => {
  it("resolves existing aliases without registering projects", () => {
    expect(resolveDiagnosticProject(map, "/diagnostic/alias", "sqlite")).toEqual({ projectId: hash, localProjectId: hash });
    expect(resolveDiagnosticProject(map, "/diagnostic/project", "postgresql")).toEqual({ projectId: remote, localProjectId: hash });
  });
  it("uses a deterministic SQLite identity for missing state, refuses remote global fallback", () => {
    const id = hashProjectPath("/diagnostic/unknown");
    expect(resolveDiagnosticProject(null, "/diagnostic/unknown", "sqlite")).toEqual({ projectId: id, localProjectId: id });
    expect(() => resolveDiagnosticProject(null, "/diagnostic/unknown", "postgresql")).toThrow("Project diagnostic identity is unavailable.");
    expect(() => resolveDiagnosticProject(map, "/diagnostic/unknown", "postgresql")).toThrow("Project diagnostic identity is unavailable.");
  });
  it.each([
    "not-json", "null", "[]", '{"invalid":{}}',
    JSON.stringify({ [hash]: null }),
    JSON.stringify({ [hash]: { canonical: "relative", aliases: [] } }),
    JSON.stringify({ [hash]: { canonical: "/diagnostic/project", aliases: ["relative"] } }),
    JSON.stringify({ [hash]: { canonical: "/diagnostic/project", aliases: [], remoteProjectId: "canary-secret" } }),
    JSON.stringify({ [hash]: { canonical: "/diagnostic/project", aliases: [] }, ["b".repeat(64)]: { canonical: "/diagnostic/project", aliases: [] } }),
  ])("refuses malformed or ambiguous metadata without echoing values", content => {
    expect(() => resolveDiagnosticProject(content, "/diagnostic/project", "postgresql")).toThrow("Project diagnostic identity is unavailable.");
  });
  it("refuses a PostgreSQL project without remote binding", () => {
    expect(() => resolveDiagnosticProject(JSON.stringify({ [hash]: { canonical: "/diagnostic/project", aliases: [] } }), "/diagnostic/project", "postgresql")).toThrow("Project diagnostic identity is unavailable.");
  });
});
