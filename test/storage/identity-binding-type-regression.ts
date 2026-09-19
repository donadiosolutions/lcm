// Compile-only guard for #1430.
//
// `localProjectIdentity` is deliberately unbound: it exists for hook
// durability and must never reach a call site that requires a PostgreSQL
// remote binding. Before the fix its result structurally satisfied
// `ProjectIdentity`, so that pairing compiled and then refused every
// project forever at runtime.
//
// The `@ts-expect-error` below is the regression guard: it fails the
// typecheck if the pairing ever compiles again.
import type { LocalProjectIdentity } from "../../src/daemon/project.js";
import type { BoundProjectIdentity } from "../../src/project-map.js";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import {
  resolveBoundStorageIdentityContext,
  resolveStorageIdentityContext,
} from "../../src/storage/identity-context.js";

declare const postgresql: Extract<ResolvedStorageConfig, { backend: "postgresql" }>;
declare const sqlite: Extract<ResolvedStorageConfig, { backend: "sqlite" }>;
declare const local: LocalProjectIdentity;
declare const bound: BoundProjectIdentity;

// The trap from #1430: an unbound hook-durability identity must not satisfy
// the PostgreSQL call site.
// @ts-expect-error unbound identity is not assignable where a remote binding is required
void resolveStorageIdentityContext(postgresql, local);

// A genuinely bound identity still resolves.
void resolveStorageIdentityContext(postgresql, bound);

// SQLite has no binding to check, so any local identity is accepted.
void resolveStorageIdentityContext(sqlite, local);

// A maybe-unbound identity reaches PostgreSQL only through the explicit
// helper, which refuses loudly instead of degrading into a silent refusal.
void resolveBoundStorageIdentityContext(postgresql, local);
