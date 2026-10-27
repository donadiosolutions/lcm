import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../src/storage/portable-record.js";
import {
  ActivationPublicationIdError,
  deriveActivationPublicationId,
} from "../../src/migration/activation-publication-id.js";

/** The exact pattern backend-publication.ts, activation-artifact-store.ts
 * and activation-publication.ts each apply to a publicationId. */
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

describe("deriveActivationPublicationId", () => {
  it("is deterministic: the same generation id always derives the same publicationId", () => {
    expect(deriveActivationPublicationId("generation-1")).toBe(deriveActivationPublicationId("generation-1"));
  });

  it("differs between generations", () => {
    expect(deriveActivationPublicationId("generation-1")).not.toBe(deriveActivationPublicationId("generation-2"));
  });

  it("is PUBLICATION_ID_PATTERN-valid and depends on no attempt-time observation", () => {
    const id = deriveActivationPublicationId("generation-1");
    expect(id).toMatch(PUBLICATION_ID_PATTERN);
    expect(id).toBe(sha256(canonicalJson(["activation-publication-v1", "generation-1"])));
  });

  it("never collides with rollback's derivation for the same generation (distinct domain prefix)", () => {
    const rollbackShape = sha256(canonicalJson(["rollback-publication-v1", "generation-1"]));
    expect(deriveActivationPublicationId("generation-1")).not.toBe(rollbackShape);
  });

  it.each([
    ["empty", ""],
    ["leading punctuation", "-generation"],
    ["forbidden character", "generation/1"],
    ["too long", "g".repeat(129)],
  ])("rejects an invalid generation id (%s) before hashing", (_name, generationId) => {
    expect(() => deriveActivationPublicationId(generationId)).toThrow(ActivationPublicationIdError);
  });

  it("rejects a non-string generation id", () => {
    expect(() => deriveActivationPublicationId(42 as unknown as string)).toThrow(ActivationPublicationIdError);
  });
});
