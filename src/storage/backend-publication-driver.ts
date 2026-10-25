import {
  applyBackendPublicationConfigFile,
} from "../config-manager.js";
import {
  applyBackendPublicationProjectMapFile,
} from "../project-map.js";
import {
  BackendPublicationCoordinator,
  captureBackendPublicationState,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationObserver,
  type BackendPublicationRemoteContext,
} from "./backend-publication.js";

/**
 * Production adapter over the three optional remote-guard hooks a {@link
 * BackendPublicationDriver} may implement. Both current Epic #92 consumers
 * (#625 activation, #626 rollback) acquire their PostgreSQL fenced lease
 * before the coordinator is involved, so {@link acquireRemoteGuard} is
 * reached with a lease the caller already owns. A production implementation
 * adopts that same generation idempotently; it does not take a fresh one.
 *
 * Two properties the provider must honour, load-bearing enough to repeat
 * here rather than leave to be rediscovered by reading the coordinator:
 *
 * - The coordinator's own release phase ({@link
 *   BackendPublicationCoordinator}'s internal `#releaseAll`) frees the
 *   fence on the completed path. A provider must not release it again
 *   after handoff back to its caller.
 * - Expiry is not release. The coordinator's release path requires an
 *   UNEXPIRED row before it will call {@link releaseRemoteGuard} — an
 *   expired fence is reacquired and only the successor is released. A
 *   provider whose own lease has expired by the time the coordinator asks
 *   it to release must take the fence over (acquire a fresh row) before
 *   releasing it, not attempt to release the expired one directly.
 */
export interface BackendPublicationRemoteGuardProvider {
  acquireRemoteGuard(
    input: BackendPublicationRemoteContext,
  ): Promise<BackendPublicationFenceRecord>;
  readRemoteGuard(
    input: BackendPublicationRemoteContext,
    operation: "acquire" | "release",
  ): Promise<BackendPublicationFenceRecord | null>;
  releaseRemoteGuard(
    input: BackendPublicationRemoteContext
      & Readonly<{ fence: BackendPublicationFenceRecord }>,
  ): Promise<void>;
  /**
   * Optional capability: read the project's row whichever generation it
   * names, without refusing another target backend, evidence or machine.
   *
   * Declaring it asserts the provider's guard only ever rebinds a RELEASED
   * row to a different identity and gives every rebinding a strictly greater
   * fencing token. The coordinator then treats a row of another identity
   * with a greater token as proof that the journalled fence was released
   * before a later publication acquired the row (Bug #1651), and finishes
   * its own release tail without touching that row. Absent, the coordinator
   * keeps failing closed on any changed identity.
   */
  readRemoteGuardForReleaseReconciliation?(
    input: BackendPublicationRemoteContext,
  ): Promise<BackendPublicationFenceRecord | null>;
}

/**
 * An EXPLICIT, no-default choice of remote-guard behaviour for a produced
 * driver or coordinator.
 *
 * There is no default because absence is not inert. The coordinator refuses
 * a publication that names projects unless the driver supplies a complete
 * remote guard provider, so `{ mode: "absent", acknowledged: true }` can only
 * ever publish a ZERO-PROJECT publication: one that changes no project's
 * remote binding. For such a publication the journal records the guarded
 * phase although no remote guard ran, and the caller names that
 * explicitly; a stray `{ mode: "absent" }` without the sibling field is
 * refused. Every publication that binds or unbinds a project needs
 * `{ mode: "delegated", provider }`, which wires all three remote-guard
 * hooks to the caller-supplied {@link BackendPublicationRemoteGuardProvider}.
 */
export type BackendPublicationRemoteGuardChoice =
  | Readonly<{ mode: "absent"; acknowledged: true }>
  | Readonly<{ mode: "delegated"; provider: BackendPublicationRemoteGuardProvider }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRemoteGuardChoice(
  remoteGuard: unknown,
): asserts remoteGuard is BackendPublicationRemoteGuardChoice {
  if (!isRecord(remoteGuard)) {
    throw new TypeError(
      "backend publication remote guard choice must be an explicit object with a \"mode\" field",
    );
  }
  const mode = remoteGuard.mode;
  if (mode === "absent") {
    if (remoteGuard.acknowledged !== true) {
      throw new TypeError(
        "backend publication remote guard absence must set acknowledged: true; "
          + "omitting the remote guard is not a valid way to reach this path",
      );
    }
    return;
  }
  if (mode === "delegated") {
    const provider = remoteGuard.provider;
    if (!isRecord(provider)) {
      throw new TypeError(
        "backend publication remote guard delegation requires a provider object",
      );
    }
    for (const method of ["acquireRemoteGuard", "readRemoteGuard", "releaseRemoteGuard"] as const) {
      if (typeof provider[method] !== "function") {
        throw new TypeError(
          `backend publication remote guard provider is missing required method: ${method}`,
        );
      }
    }
    const reconcile = provider.readRemoteGuardForReleaseReconciliation;
    if (reconcile !== undefined && typeof reconcile !== "function") {
      throw new TypeError(
        "backend publication remote guard provider readRemoteGuardForReleaseReconciliation must be a function when present",
      );
    }
    return;
  }
  throw new TypeError(
    `backend publication remote guard choice must have mode "absent" or "delegated", received: ${JSON.stringify(mode)}`,
  );
}

export type CreateBackendPublicationDriverOptions = Readonly<{
  remoteGuard: BackendPublicationRemoteGuardChoice;
}>;

/**
 * Build the ONE production {@link BackendPublicationDriver}.
 *
 * Every file-mutation method below binds to an existing, merged, permit-
 * gated production implementation; none of them write bytes themselves.
 * `retainCompletedMaterial` and `cleanupAbortedMaterial` are DELIBERATELY
 * ABSENT from the returned driver — see the module-level note below rather
 * than "completing" the interface by adding no-op implementations.
 *
 * RETENTION AND CLEANUP, WHY BOTH HOOKS ARE ABSENT:
 *
 * When a driver leaves `cleanupAbortedMaterial` undefined, the coordinator
 * performs its OWN deletion of the retained material file on the abort
 * path (backend-publication.ts's internal `#cleanupMaterial`): a bounded,
 * permission- and single-link-checked, digest-verified
 * `consumeBoundedRegularFile` against the sealed `recoveryReference`. A
 * driver-supplied no-op `cleanupAbortedMaterial` does not run in ADDITION
 * to that deletion; the coordinator's internal implementation checks
 * whether the hook is defined and, if so, calls it and RETURNS WITHOUT
 * EVER RUNNING ITS OWN DELETION. A no-op hook therefore leaks the material
 * file on every abort. Because `prepare()` seals new material with
 * `requireAbsent: true`, that leaked file then refuses a later publication
 * that reuses the same publication id. Leave the hook undefined so the
 * coordinator's own, strictly more thorough deletion runs.
 *
 * `retainCompletedMaterial` is only ever invoked from the completed path,
 * and that same internal `#cleanupMaterial` deletion is reached ONLY from
 * the abort path. Nothing deletes the material file when a publication
 * completes. Retention is therefore already a property of the coordinator's
 * behaviour on the completed path, independent of whether this hook is
 * defined. A hook that re-authenticates what the coordinator's own
 * `#materialContext` authenticated moments earlier would add no new
 * evidence; it is exactly the "a check that is never compared" shape this
 * Epic keeps finding. Leave it undefined and prove retention with a test
 * that drives a real publication to completion and reads the file back.
 */
export function createBackendPublicationDriver(
  options: CreateBackendPublicationDriverOptions,
): BackendPublicationDriver {
  assertRemoteGuardChoice(options.remoteGuard);

  const driver: BackendPublicationDriver = {
    async observeLocalState(input) {
      return captureBackendPublicationState(input.homeDir);
    },
    async publishConfig(input) {
      return applyBackendPublicationConfigFile(input);
    },
    async restoreConfig(input) {
      return applyBackendPublicationConfigFile(input);
    },
    async publishProjectMap(input) {
      return applyBackendPublicationProjectMapFile(input);
    },
    async restoreProjectMap(input) {
      return applyBackendPublicationProjectMapFile(input);
    },
    // retainCompletedMaterial and cleanupAbortedMaterial are deliberately
    // omitted; see the doc comment above.
  };

  if (options.remoteGuard.mode === "delegated") {
    const provider = options.remoteGuard.provider;
    return {
      ...driver,
      acquireRemoteGuard: (input) => provider.acquireRemoteGuard(input),
      readRemoteGuard: (input, operation) => provider.readRemoteGuard(input, operation),
      releaseRemoteGuard: (input) => provider.releaseRemoteGuard(input),
      ...(provider.readRemoteGuardForReleaseReconciliation === undefined ? {} : {
        readRemoteGuardForReleaseReconciliation: (input: BackendPublicationRemoteContext) =>
          provider.readRemoteGuardForReleaseReconciliation!(input),
      }),
    };
  }
  return driver;
}

export type CreateBackendPublicationCoordinatorOptions = Readonly<{
  homeDir?: string;
  observer?: BackendPublicationObserver;
  remoteGuard: BackendPublicationRemoteGuardChoice;
}>;

/**
 * The ONE production construction site for {@link
 * BackendPublicationCoordinator}, wiring it over the driver returned by
 * {@link createBackendPublicationDriver}. Both #625 (migration activation)
 * and #626 (migration rollback) construct their coordinator through this
 * factory rather than constructing one directly.
 */
export function createBackendPublicationCoordinator(
  options: CreateBackendPublicationCoordinatorOptions,
): BackendPublicationCoordinator {
  const driver = createBackendPublicationDriver({ remoteGuard: options.remoteGuard });
  return new BackendPublicationCoordinator({
    homeDir: options.homeDir,
    driver,
    observer: options.observer,
  });
}
