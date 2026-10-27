import { resolveExistingMigrationGeneration, refuseUnlessRouted, type ExistingGenerationContext, type ExistingGenerationInput } from "./existing-generation.js";
import type { MigrationRouteCommand } from "./routing.js";

/**
 * Plan-v5 Part B (1) and plan-v4 section 3, as one admission step shared by
 * every existing-generation command that mutates (`verify`, `resume` and the
 * routed `abort`): resolve the explicit or live generation, let the router
 * say whether this command may act on its cell, and only then compare the
 * operator's `--confirm-generation` against the resolved id.
 *
 * The owner check comes first because a refusal there names the command that
 * does own the cell and has nothing to confirm; the fence comes second and is
 * the last read before the command's first durable write. Every step here
 * reads only, so a refusal at either leaves durable state byte-identical.
 */

export type ExistingCommandName = Exclude<MigrationRouteCommand, "report">;

export type ExistingAdmission =
  | Readonly<{ status: "admitted"; context: ExistingGenerationContext }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    /** The generation the refusal is about, so a confirmation refusal tells the operator what to pass. */
    generationId?: string;
    /** The command the router names as the way forward, when it names one. */
    next?: string | null;
  }>;

export type ExistingCommandInput = Readonly<{
  command: ExistingCommandName;
  homeDir: string;
  /** The explicit `--generation`. Absent means "the live non-terminal hold". */
  generation?: string;
  resolution?: Pick<ExistingGenerationInput, "manifestStore" | "_operationsForTesting">;
}>;

export async function admitExistingMigrationCommand(input: ExistingCommandInput): Promise<ExistingAdmission> {
  const resolution = await resolveExistingMigrationGeneration({
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...input.resolution,
  });
  if (resolution.status === "refuse") return resolution;
  const { context } = resolution;
  const refused = refuseUnlessRouted(input.command, context.route);
  if (refused !== null) {
    return { status: "refuse", reason: refused.reason, generationId: context.generationId, next: refused.next };
  }
  return { status: "admitted", context };
}

/** The closed pair of reasons a command uses when its confirmation is missing or no longer matches. */
export type ConfirmationReasons = Readonly<{ missing: string; moved: string }>;

export const EXISTING_CONFIRMATION_REASONS: ConfirmationReasons = Object.freeze({
  missing: "existing-confirmation-missing",
  moved: "existing-confirmation-moved",
});

export function refuseUnlessConfirmed(input: Readonly<{
  expectedGenerationId: string;
  confirmGenerationId: string | undefined;
  reasons?: ConfirmationReasons;
}>): Readonly<{ status: "refuse"; reason: string; generationId: string }> | null {
  const reasons = input.reasons ?? EXISTING_CONFIRMATION_REASONS;
  if (input.confirmGenerationId === undefined) {
    return { status: "refuse", reason: reasons.missing, generationId: input.expectedGenerationId };
  }
  if (input.confirmGenerationId !== input.expectedGenerationId) {
    return { status: "refuse", reason: reasons.moved, generationId: input.expectedGenerationId };
  }
  return null;
}

/**
 * The closed pair of reasons the `--confirm-backend` fence uses (plan-v5 Part
 * A item 3). The literal is the backend the command switches to: the
 * manifest's `destination.backend` for `activate` ("postgresql") and its
 * `source.backend` for `rollback` ("sqlite"). The manifest invariant makes
 * each the only legal value, so the fence confirms intent and does not detect
 * the wrong direction.
 */
export const BACKEND_CONFIRMATION_REASONS: ConfirmationReasons = Object.freeze({
  missing: "backend-confirmation-missing",
  moved: "backend-confirmation-moved",
});

export function refuseUnlessBackendConfirmed(input: Readonly<{
  expectedBackend: string;
  confirmBackend: string | undefined;
  generationId: string;
}>): Readonly<{ status: "refuse"; reason: string; generationId: string }> | null {
  if (input.confirmBackend === undefined) {
    return { status: "refuse", reason: BACKEND_CONFIRMATION_REASONS.missing, generationId: input.generationId };
  }
  if (input.confirmBackend !== input.expectedBackend) {
    return { status: "refuse", reason: BACKEND_CONFIRMATION_REASONS.moved, generationId: input.generationId };
  }
  return null;
}

