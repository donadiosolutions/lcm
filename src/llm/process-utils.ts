export const MAX_MODEL_DISPLAY_LENGTH = 80;

export function boundedModelForDisplay(model: string): string {
  const sanitized = model
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_MODEL_DISPLAY_LENGTH) return sanitized || "default";
  return `${sanitized.slice(0, MAX_MODEL_DISPLAY_LENGTH)}...[truncated]`;
}

export function createProcessCompatibilityError(options: {
  cliName: string;
  providerId: string;
  code: number | null;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): Error {
  const model = boundedModelForDisplay(options.model ?? "default");
  const reasoningEffort = options.reasoningEffort ?? "default/omitted";
  const fastMode = options.fastMode === undefined ? "default/omitted" : String(options.fastMode);
  return new Error(
    `${options.cliName} CLI rejected the compaction request (exit ${options.code ?? "unknown"}; diagnostic output omitted): ` +
      `provider ${options.providerId}, model ${JSON.stringify(model)}, reasoning effort ${JSON.stringify(reasoningEffort)}, ` +
      `fast mode ${fastMode}. Upgrade the ${options.cliName} CLI or choose a supported model and control combination.`,
  );
}
