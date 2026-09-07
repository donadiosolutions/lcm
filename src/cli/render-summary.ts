/**
 * Summary renderer — prints the final summary after all sessions are processed.
 * Replaces import-summary.ts for commands that use the ninja renderer.
 */

import type { ProgressState } from './progress-state.js';
import { sanitizeTerminalText } from '../terminal-sanitize.js';
import type { RenderOpts } from './render-frame.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtRatio(before: number, after: number): string {
  return (before / after).toFixed(1) + '×';
}

function renderBar(barWidth: number): string {
  return '[' + '█'.repeat(barWidth) + ']';
}

/** Print the compact (non-verbose) summary table to the supplied output stream. */
export function printSummary(state: ProgressState, opts: RenderOpts, output: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  const elapsed = (Date.now() - state.startedAt) / 1_000;
  const processed = state.completed + state.errors.length;
  const width = Math.max(opts.width, 40);

  // Phase bar (only if there are phases)
  if (state.phases.length > 0) {
    const phaseBar = state.phases
      .map(p => `● ${p.name}`)
      .join('  →  ');
    const doneLabel = state.aborted
      ? 'Aborted'
      : state.errors.length > 0 || state.phaseErrors.length > 0
        ? 'Failed ✗'
        : 'Done ✓';
    output.write(`\n  ${phaseBar}          ${doneLabel}\n`);
  }

  // Progress bar
  const barWidth = width < 60 ? 20 : 22;
  const pct = state.total > 0 ? Math.round((processed / state.total) * 100) : 100;
  let tokenFlowStr = '';
  if (state.tokensIn > 0) {
    if (state.tokensOut > 0 && state.tokensOut < state.tokensIn) {
      const ratio = fmtRatio(state.tokensIn, state.tokensOut);
      tokenFlowStr = `  ${fmtTokens(state.tokensIn)} → ${fmtTokens(state.tokensOut)} tokens, ${ratio}`;
    } else {
      tokenFlowStr = `  ${fmtTokens(state.tokensIn)} tokens`;
    }
  }
  const msgs = state.messagesIn > 0 ? `  ${state.messagesIn.toLocaleString()} msgs` : '';
  output.write(`\n  ${renderBar(barWidth)} ${pct}%${msgs}${tokenFlowStr}\n`);

  // Metrics table
  const border = '─'.repeat(49);
  output.write(`\n  ${border}\n`);

  const rows: [string, string][] = [];

  rows.push(['Sessions', `${processed} processed`]);

  if (state.tokensIn > 0 && state.tokensOut > 0 && state.tokensOut < state.tokensIn) {
    rows.push(['Compression', fmtRatio(state.tokensIn, state.tokensOut)]);
  }

  if (state.dag) {
    rows.push(['DAG nodes', `${state.dag.nodes}  (+${state.dag.newNodes} new)`]);
    rows.push(['DAG depth', String(state.dag.depth)]);
    if (state.dag.memoriesPromoted > 0) {
      rows.push(['Memories', `${state.dag.memoriesPromoted} promoted`]);
    }
  }

  rows.push(['Total time', `${elapsed.toFixed(1)}s`]);

  if (state.errors.length > 0) {
    rows.push(['Failed', String(state.errors.length)]);
  }
  if (state.phaseErrors.length > 0) {
    rows.push(['Phase failed', String(state.phaseErrors.length)]);
  }

  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  for (const [label, value] of rows) {
    output.write(`  ${label.padEnd(labelWidth)}  ${value}\n`);
  }

  output.write(`  ${border}\n`);

  // Error list
  if (state.errors.length > 0) {
    output.write('\n  Failed:\n');
    for (const { sessionId, message } of state.errors) {
      output.write(`    ${sanitizeTerminalText(sessionId)}: ${sanitizeTerminalText(message)}\n`);
    }
  }
  if (state.phaseErrors.length > 0) {
    output.write('\n  Phase failures:\n');
    for (const { phase, target, message } of state.phaseErrors) {
      const safePhase = sanitizeTerminalText(phase);
      const safeTarget = target ? ` (${sanitizeTerminalText(target)})` : '';
      output.write(`    ${safePhase}${safeTarget}: ${sanitizeTerminalText(message)}\n`);
    }
  }

  output.write('\n');
}
