import { expect, it } from "vitest";
import * as api from "../../src/storage/portable.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { createPostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { openSqlitePortableSource } from "../../src/storage/sqlite/portable-source.js";
import { openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import { runPortableTransfer } from "../../src/storage/portable-transfer.js";

it("exports the existing portable implementations without publication authority or wrappers", () => {
  expect(api.createPostgreSqlPortableSource).toBe(createPostgreSqlPortableSource);
  expect(api.createPostgreSqlPortableDestination).toBe(createPostgreSqlPortableDestination);
  expect(api.openSqlitePortableSource).toBe(openSqlitePortableSource);
  expect(api.openSqlitePortableDestination).toBe(openSqlitePortableDestination);
  expect(api.runPortableTransfer).toBe(runPortableTransfer);
  expect(api).not.toHaveProperty("BackendPublicationCoordinator");
  expect(api).not.toHaveProperty("createStorageBackendFactory");
  expect(api.canonicalJson({ value: "record" })).toBe('{"value":"record"}');
});
