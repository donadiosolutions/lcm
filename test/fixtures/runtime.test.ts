import { describe, expect, it } from "vitest";
import { withHttpHandler } from "./runtime.js";

describe("withHttpHandler", () => {
  it("returns a deterministic 500 response when an async handler rejects", async () => {
    await withHttpHandler(
      async () => {
        await Promise.resolve();
        throw new Error("deterministic handler rejection");
      },
      async (baseUrl) => {
        const response = await fetch(baseUrl);

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe("Internal Server Error");
      },
    );
  });
});
