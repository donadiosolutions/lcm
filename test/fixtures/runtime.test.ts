import { describe, expect, it } from "vitest";
import { withHttpHandler } from "./runtime.js";

describe("withHttpHandler", (): void => {
  it("returns a deterministic 500 response when an async handler rejects", async (): Promise<void> => {
    await withHttpHandler(
      async (): Promise<void> => {
        await Promise.resolve();
        throw new Error("deterministic handler rejection");
      },
      async (baseUrl: string): Promise<void> => {
        const response = await fetch(baseUrl);

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe("Internal Server Error");
      },
    );
  });
});
