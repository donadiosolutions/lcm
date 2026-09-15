import { createRepositoryInsert } from "./dedup-test-helper.js";
import { PromotedStore } from "../../src/db/promoted.js";

/** Compile-only guard for the actual repositoryDeps insert helper from #1205. */
declare const store: PromotedStore;
void createRepositoryInsert(store, "bound-project");
