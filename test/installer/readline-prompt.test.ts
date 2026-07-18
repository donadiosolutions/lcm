import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  question: vi.fn().mockResolvedValue("answer"),
  close: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => mocks),
}));

import { _readlinePromptForTesting } from "../../installer/install.js";

describe("installer readline prompt", () => {
  it("closes the interface after success and failure", async () => {
    await expect(_readlinePromptForTesting("question")).resolves.toBe("answer");
    expect(mocks.close).toHaveBeenCalledTimes(1);
    mocks.question.mockRejectedValueOnce(new Error("failed"));
    await expect(_readlinePromptForTesting("question")).rejects.toThrow("failed");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
