import type { ImportResult } from "./import.js";
import { formatNumber, formatRatio } from "./stats.js";

export function printCodexResolutionSummary(result: ImportResult, log: (value?: string) => void = console.log): void {
  if ((result.reconciled ?? 0) > 0) {
    log(`  ${result.reconciled} historical Codex sessions reconciled`);
  }
  if ((result.unresolved ?? 0) > 0) {
    log(`  ${result.unresolved} Codex sessions unresolved (skipped)`);
  }
  if ((result.ambiguous ?? 0) > 0) {
    log(`  ${result.ambiguous} Codex sessions ambiguous (skipped)`);
  }
}

export function printImportSummary(
  result: ImportResult,
  opts: { replay?: boolean; log?: (value?: string) => void } = {},
): void {
  const log = opts.log ?? console.log;
  const sessionsProcessed = result.imported + result.skippedEmpty + result.failed;
  const tokenSuffix = result.totalTokens > 0 ? `, ${formatNumber(result.totalTokens)} tokens` : "";
  log(`  ${result.imported} sessions imported (${result.totalMessages} messages${tokenSuffix})`);
  if (result.skippedEmpty > 0) log(`  ${result.skippedEmpty} skipped (empty transcript)`);
  if (result.failed > 0) log(`  ${result.failed} failed`);
  printCodexResolutionSummary(result, log);

  if (opts.replay) {
    log("  [replay] Sessions compacted sequentially with threaded context.");
  }

  // Show compression summary when tokens were ingested
  if (result.totalTokens > 0) {
    const border = "\u2500".repeat(41);
    log();
    log(`  ${border}`);

    const rows: [string, string][] = [
      ["Sessions processed", String(sessionsProcessed)],
      ["Tokens ingested", formatNumber(result.totalTokens)],
    ];

    if (opts.replay && result.totalTokens > result.tokensAfter) {
      const ratio = formatRatio(result.totalTokens, result.tokensAfter);
      const freed = result.totalTokens - result.tokensAfter;
      rows.push(
        ["Tokens after", formatNumber(result.tokensAfter)],
        ["Compression ratio", `${ratio}\u00d7`],
        ["Tokens freed", formatNumber(freed)],
      );
    }

    const labelWidth = Math.max(...rows.map(([l]) => l.length));
    for (const [label, value] of rows) {
      log(`  ${label.padEnd(labelWidth)} : ${value}`);
    }

    log(`  ${border}`);
  }
}
