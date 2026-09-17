/**
 * Lifecycle orchestrator for the ninja CLI renderer.
 * Manages the render loop, SIGINT/SIGWINCH handlers, and session iteration.
 */

import type { ProgressState } from './progress-state.js';
import { renderFrame, FRAME_LINES, type RenderOpts } from './render-frame.js';
import { printSummary } from './render-summary.js';
import type { CompactProgressEvent } from '../batch-compact.js';
import { boundedTerminalText } from '../terminal-sanitize.js';

export interface PipelineRunnerOpts {
  state: ProgressState;
  /** Destination for progress; callers emitting data on stdout use stderr. */
  output?: Pick<NodeJS.WriteStream, "write" | "columns">;
  renderOpts: RenderOpts;
  /** Called once the runner has started (before session iteration begins) */
  onReady?: () => void;
  /** Whether the renderer owns process signal handlers. */
  handleSignals?: boolean;
  /** Called for SIGINT/SIGTERM when an external lifecycle owns drain. */
  onSignal?: (signal: 'SIGINT' | 'SIGTERM') => void;
}

/**
 * NinjaRenderer — manages the live display lifecycle.
 *
 * Usage:
 *   const renderer = new NinjaRenderer({ state, renderOpts });
 *   renderer.start();
 *   // ... mutate state ...
 *   renderer.sessionDone(lastResult);  // emit non-TTY/verbose line
 *   renderer.stop();                   // stop render loop
 *   renderer.printSummary();
 */
export class NinjaRenderer {
  private readonly output: Pick<NodeJS.WriteStream, "write" | "columns">;
  private state: ProgressState;
  private opts: RenderOpts;
  private intervalId?: ReturnType<typeof setInterval>;
  private liveFrameReserved = false;
  private firstFrame = true;
  private sigintHandler?: () => void;
  private sigtermHandler?: () => void;
  private sigwinchHandler?: () => void;
  private onReady?: () => void;
  private readonly handleSignals: boolean;
  private readonly onSignal?: (signal: 'SIGINT' | 'SIGTERM') => void;

  constructor(opts: PipelineRunnerOpts) {
    this.output = opts.output ?? process.stdout;
    this.state = opts.state;
    this.opts = opts.renderOpts;
    this.onReady = opts.onReady;
    this.handleSignals = opts.handleSignals ?? true;
    this.onSignal = opts.onSignal;
  }

  /** Start the render loop and register signal handlers. */
  start(): void {
    const { isTTY, verbose } = this.opts;

    // Register SIGWINCH to update terminal width
    this.sigwinchHandler = () => {
      this.opts.width = this.output.columns ?? 80;
    };
    process.on('SIGWINCH', this.sigwinchHandler);

    if (this.handleSignals) {
      const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
        this.state.aborted = true;
        if (this.onSignal !== undefined) {
          this.onSignal(signal);
          return;
        }
        this.stop();
        this.printSummary();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };
      this.sigintHandler = () => handleSignal('SIGINT');
      this.sigtermHandler = () => handleSignal('SIGTERM');
      process.on('SIGINT', this.sigintHandler);
      process.on('SIGTERM', this.sigtermHandler);
    }

    if (isTTY && !verbose) {
      // Emit blank lines to reserve space for the 3-line frame
      this.output.write('\n\n\n');
      this.firstFrame = false;
      this.liveFrameReserved = true;

      // 16 fps render loop
      this.intervalId = setInterval(() => {
        this._writeFrame();
      }, 62);
    }

    const onReady = this.onReady;
    this.onReady = undefined;
    onReady?.();
  }

  /** Stop the render loop and remove signal handlers. */
  stop(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = undefined;
    }
    if (this.sigtermHandler) {
      process.removeListener('SIGTERM', this.sigtermHandler);
      this.sigtermHandler = undefined;
    }
    if (this.sigwinchHandler) {
      process.removeListener('SIGWINCH', this.sigwinchHandler);
      this.sigwinchHandler = undefined;
    }
    // Write one final frame to reflect the completed state
    if (this.liveFrameReserved) {
      this._writeFrame();
      this.liveFrameReserved = false;
    }
  }

  /**
   * Called when a session finishes.
   * In non-TTY or verbose mode, emits a log line.
   * In TTY non-verbose, the render loop handles it.
   */
  sessionDone(): void {
    const { isTTY, verbose } = this.opts;
    if (!isTTY || verbose) {
      const line = renderFrame(this.state, this.opts, 0);
      if (line) this.output.write(line);
    }
  }

  /** Apply and synchronously render one identity-bearing compact lifecycle event. */
  handleEvent(event: CompactProgressEvent): void {
    if (event.type === 'discovery-start') {
      return;
    }
    if (event.type === 'discovery-item-start') {
      this.state.discovery = {
        index: event.index,
        total: event.total,
        project: event.project,
      };
      const line = `  scanning project ${event.index}/${event.total} ${boundedTerminalText(event.project, 48)}`;
      this._writeLifecycleLine(line);
      return;
    }
    if (event.type === 'discovery-item-terminal') return;
    if (event.type === 'discovery-clear') {
      this.state.discovery = undefined;
      if (this.opts.isTTY && !this.opts.verbose) this._writeFrame();
      return;
    }
    if (event.type === 'phase-failure') {
      this.state.phaseErrors.push({
        phase: event.phase,
        ...(event.project === undefined ? {} : { target: event.project }),
        message: event.message,
      });
      const target = event.project ? ` ${boundedTerminalText(event.project, 48)}` : '';
      this._writeLifecycleLine(
        `  failed${target}: ${boundedTerminalText(event.message, 96)} (failure total ${this.failureTotal()})`,
      );
      return;
    }
    if (event.type === 'session-start') {
      const current = {
        sessionId: event.identity.sessionId,
        project: event.identity.project,
        conversationId: event.identity.conversationId,
        ...(event.identity.sourceLocator === undefined ? {} : { sourceLocator: event.identity.sourceLocator }),
        messages: event.messages,
        tokens: event.tokens,
        startedAt: event.startedAt,
      };
      this.state.activeSessions.push(current);
      this.state.current = current;
      this._writeLifecycleLine(`  processing ${this.renderIdentity(event.identity)}`);
      return;
    }
    const identity = event.identity;
    this.state.activeSessions = this.state.activeSessions.filter(session => !(
      session.project === identity.project
      && session.sessionId === identity.sessionId
      && session.conversationId === identity.conversationId
    ));
    this.state.current = this.state.activeSessions[0];
    if (event.outcome === 'failed') {
      this.state.errors.push({
        project: identity.project,
        sessionId: identity.sessionId,
        conversationId: identity.conversationId,
        ...(identity.sourceLocator === undefined ? {} : { sourceLocator: identity.sourceLocator }),
        message: event.message ?? 'compaction request failed',
      });
    } else {
      this.state.completed += 1;
    }
    this.state.lastResult = {
      project: identity.project,
      sessionId: identity.sessionId,
      conversationId: identity.conversationId,
      ...(identity.sourceLocator === undefined ? {} : { sourceLocator: identity.sourceLocator }),
      outcome: event.outcome,
      messages: event.messages,
      tokensBefore: event.tokensBefore,
      ...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
      ...(event.provider === undefined ? {} : { provider: event.provider }),
      elapsed: event.elapsed,
    };
    const provider = event.provider
      ? ` · provider ${boundedTerminalText(event.provider, 32)}`
      : '';
    const message = event.message ? `: ${boundedTerminalText(event.message, 96)}` : '';
    this._writeLifecycleLine(
      `  ${event.outcome} ${this.renderIdentity(identity)}${provider}${message}`,
    );
  }

  /** Print the final summary. */
  printSummary(): void {
    // In TTY non-verbose mode we need to move past the live frame
    if (this.opts.isTTY && !this.opts.verbose) {
      this.output.write('\n');
    }
    printSummary(this.state, this.opts, this.output);
  }

  /** Update the render opts (e.g. after SIGWINCH) */
  updateOpts(patch: Partial<RenderOpts>): void {
    Object.assign(this.opts, patch);
  }

  private _writeFrame(): void {
    const frame = renderFrame(this.state, this.opts, this.firstFrame ? 0 : FRAME_LINES);
    this.firstFrame = false;
    if (frame) this.output.write(frame);
  }

  private failureTotal(): number {
    return this.state.errors.length + this.state.phaseErrors.length;
  }

  private renderIdentity(identity: {
    project: string;
    sessionId: string;
    conversationId: number;
    sourceLocator?: string;
  }): string {
    const hasSource = identity.sourceLocator !== undefined;
    const dynamicWidth = Math.max(18, this.opts.width - (hasSource ? 32 : 24));
    const fieldWidth = Math.max(6, Math.floor(dynamicWidth / (hasSource ? 3 : 2)));
    const parts = [
      boundedTerminalText(identity.project, fieldWidth),
      boundedTerminalText(identity.sessionId, fieldWidth),
      `conversation ${identity.conversationId}`,
      identity.sourceLocator === undefined
        ? undefined
        : `source ${boundedTerminalText(identity.sourceLocator, fieldWidth)}`,
    ].filter((part): part is string => part !== undefined);
    return parts.join(' · ');
  }

  private _writeLifecycleLine(line: string): void {
    const bounded = `${line}\n`;
    if (this.opts.isTTY && !this.opts.verbose && this.intervalId !== undefined) {
      this.output.write(
        `\x1b[${FRAME_LINES}A\r\x1b[2K${bounded}`
        + `\r\x1b[2K\n\r\x1b[2K\n\r\x1b[2K\n`,
      );
      this.firstFrame = false;
      this._writeFrame();
      return;
    }
    this.output.write(bounded);
  }
}
