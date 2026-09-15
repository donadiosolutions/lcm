import { PromotedStore } from "../../src/db/promoted.js";
import type { PromotedMemoryRepository } from "../../src/storage/contracts.js";

export function createRepositoryInsert(store: PromotedStore, boundProjectId: string) {
  return async (input: Parameters<PromotedMemoryRepository["insert"]>[0]): Promise<string> => {
    const { sourceProjectId, ...storeInput } = input;
    return store.insert({ ...storeInput, projectId: sourceProjectId ?? boundProjectId });
  };
}
