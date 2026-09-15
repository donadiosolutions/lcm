import {
  createMemoryApi,
  memory,
  type MemoryApi,
  type SearchResult,
} from "@donadiosolutions/lcm";

declare const api: MemoryApi;
const result: Promise<SearchResult> = api.search("orchard");
const singleton: MemoryApi = memory;
void createMemoryApi;
void result;
void singleton;
