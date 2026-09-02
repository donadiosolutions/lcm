import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { createMemoryApi } from "../../src/memory/index.js";
import type { SearchResult } from "../../src/memory/index.js";

describe("createMemoryApi", () => {
  it("store calls POST /store", async () => {
    const mockPost = vi.fn().mockResolvedValue({ stored: true });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    await api.store("Decision: use PostgreSQL", ["decision"], { projectPath: "/foo" });
    expect(mockPost).toHaveBeenCalledWith("/store", { text: "Decision: use PostgreSQL", tags: ["decision"], metadata: { projectPath: "/foo" } });
  });

  it("search calls POST /search and returns both canonical layers", async () => {
    const mockPost = vi.fn().mockResolvedValue({ episodic: [{ id: "1", content: "test", source: "sqlite", score: 1.5 }], promoted: [] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    const result = await api.search("PostgreSQL decision");
    expect(result.episodic).toHaveLength(1);
    expect(result.promoted).toHaveLength(0);
    expect(Object.hasOwn(result, "semantic")).toBe(false);
    expectTypeOf<SearchResult>().not.toHaveProperty("semantic");
  });

  it("returns promoted data without a runtime semantic key", async () => {
    const mockPost = vi.fn().mockResolvedValue({ episodic: [], promoted: [{ id: "p1" }] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    const result = await api.search("canonical");

    expect(Object.hasOwn(result, "semantic")).toBe(false);
    expect(result.promoted).toEqual([{ id: "p1" }]);
  });

  it("forwards canonical and deprecated layer inputs without rewriting", async () => {
    const mockPost = vi.fn().mockResolvedValue({ episodic: [], promoted: [] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    await api.search("canonical", { layers: ["promoted"] });
    expect(mockPost).toHaveBeenLastCalledWith("/search", { query: "canonical", layers: ["promoted"] });
    await api.search("legacy", { layers: ["semantic"] });
    expect(mockPost).toHaveBeenLastCalledWith("/search", { query: "legacy", layers: ["semantic"] });
  });

  it("compact calls POST /compact via daemon", async () => {
    const mockPost = vi.fn().mockResolvedValue({ summary: "Compacted" });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    const result = await api.compact("sess-1", "/path/transcript");
    expect(result.summary).toBe("Compacted");
    expect(mockPost).toHaveBeenCalledWith("/compact", expect.objectContaining({ session_id: "sess-1" }));
  });

  it("recent calls POST /recent", async () => {
    const mockPost = vi.fn().mockResolvedValue({ summaries: [] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    await api.recent("project-hash-123");
    expect(mockPost).toHaveBeenCalledWith("/recent", expect.objectContaining({ projectId: "project-hash-123" }));
  });
});
