export const POSTGRES_IMAGE = "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";
export const NODE_IMAGE = "node:25.4.0-bookworm-slim@sha256:f9e63fcfea470fdfd6ffeb0d6a4307ecf99f7b3292707897f82ba9088aa181e5";

export const POSTGRESQL_HARNESS_IMAGES = Object.freeze([
  POSTGRES_IMAGE,
  NODE_IMAGE,
]);
