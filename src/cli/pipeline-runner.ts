/**
 * Lifecycle orchestrator for the ninja CLI renderer.
 * Manages the render loop, SIGINT/SIGWINCH handlers, and session iteration.
 */

import type { ProgressState } from './progress-state.js';
import { renderFrame, FRAME_LINES, type RenderOpts } from './render-frame.js';
import { printSummary } from './render-summary.js';

export interface PipelineRunnerOpts {
  state: ProgressState;
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
  private state: ProgressState;
  private opts: RenderOpts;
  private intervalId?: ReturnType<typeof setInterval>;
  private firstFrame = true;
  private sigintHandler?: () => void;
  private sigtermHandler?: () => void;
  private sigwinchHandler?: () => void;
  private onReady?: () => void;
  private readonly handleSignals: boolean;
  private readonly onSignal?: (signal: 'SIGINT' | 'SIGTERM') => void;

  constructor(opts: PipelineRunnerOpts) {
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
      this.opts.width = process.stdout.columns ?? 80;
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
      process.stdout.write('\n\n\n');
      this.firstFrame = false;

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
    if (this.opts.isTTY && !this.opts.verbose) {
      this._writeFrame();
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
      if (line) process.stdout.write(line);
    }
  }

  /** Print the final summary. */
  printSummary(): void {
    // In TTY non-verbose mode we need to move past the live frame
    if (this.opts.isTTY && !this.opts.verbose) {
      process.stdout.write('\n');
    }
    printSummary(this.state, this.opts);
  }

  /** Update the render opts (e.g. after SIGWINCH) */
  updateOpts(patch: Partial<RenderOpts>): void {
    Object.assign(this.opts, patch);
  }

  private _writeFrame(): void {
    const frame = renderFrame(this.state, this.opts, this.firstFrame ? 0 : FRAME_LINES);
    this.firstFrame = false;
    if (frame) process.stdout.write(frame);
  }
}
