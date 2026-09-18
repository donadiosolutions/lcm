export const POSTGRES_IMAGE = "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";
export const NODE_IMAGE = "node:25.0.0-bookworm-slim@sha256:cb4db5ec2a285632fbd8ff2fc2cc3c4cc393245b0e4d8419fc08909bf29c52ea";

export const POSTGRESQL_HARNESS_IMAGES = Object.freeze([
  POSTGRES_IMAGE,
  NODE_IMAGE,
]);
