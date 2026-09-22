import type { GapDetector } from "./gap-detector.js";

/** Quiet period after connecting, or after the last history batch, before silence counts as an answer. */
const DEFAULT_SETTLE_DELAY_MS = 60_000;
/** Trailing-edge debounce so a burst of history batches costs one review pass. */
const DEFAULT_REVIEW_DEBOUNCE_MS = 5_000;

export interface GapReviewSchedulerOptions {
  settleDelayMs?: number;
  reviewDebounceMs?: number;
  /** Receives one line per pass that changed something. */
  log?: (message: string) => void;
}

/**
 * Decides when to re-check open gaps.
 *
 * This used to hang entirely off the `messaging-history.set` event, which was
 * wrong in a way no test could see: WhatsApp only sends history on the initial
 * sync at pairing, so on an ordinary restart no batch ever arrives, and neither
 * `reviewOpenGaps` nor `settleQuietGaps` was ever called in production. Every
 * restart added ~50 rows that nothing would ever close.
 *
 * Connecting is therefore the trigger, and history batches only refine the
 * timing:
 *
 *  - connect         — arm the settle deadline
 *  - history batch   — review on the trailing edge, and push the deadline back
 *                      so an in-flight sync is never cut short
 *  - `isLatest`      — WhatsApp says that was the lot, so settle immediately
 *  - deadline passes — review once more, then take silence as the answer
 *
 * The deadline is what makes this work without history: after it, the socket
 * has been up long enough that a chat with nothing in its window was quiet
 * rather than missed.
 */
export class GapReviewScheduler {
  private readonly settleDelayMs: number;
  private readonly reviewDebounceMs: number;
  private readonly log: (message: string) => void;

  private reviewTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(
    private readonly detector: GapDetector,
    options: GapReviewSchedulerOptions = {}
  ) {
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.reviewDebounceMs = options.reviewDebounceMs ?? DEFAULT_REVIEW_DEBOUNCE_MS;
    this.log = options.log ?? (() => {});
  }

  /** The socket is up. Give history a chance to arrive, then decide regardless. */
  onConnectionOpen(): void {
    this.settled = false;
    this.armSettle();
  }

  /** A history batch landed. */
  onHistoryBatch(isLatest: boolean): void {
    if (isLatest) {
      // WhatsApp has said that is all of it — no reason to keep waiting.
      this.clearTimer("review");
      this.clearTimer("settle");
      this.runSettle();
      return;
    }

    this.clearTimer("review");
    this.reviewTimer = this.schedule(() => {
      this.reviewTimer = null;
      this.runReview();
    }, this.reviewDebounceMs);

    // More history is clearly in flight; do not call it quiet yet.
    this.armSettle();
  }

  /** Cancel pending work — for shutdown. */
  stop(): void {
    this.clearTimer("review");
    this.clearTimer("settle");
  }

  private armSettle(): void {
    if (this.settled) return;
    this.clearTimer("settle");
    this.settleTimer = this.schedule(() => {
      this.settleTimer = null;
      this.runSettle();
    }, this.settleDelayMs);
  }

  private runReview(): number {
    const closed = this.detector.reviewOpenGaps();
    if (closed > 0) this.log(`🕳️  Gaps closed by history sync: ${closed}`);
    return closed;
  }

  private runSettle(): void {
    this.settled = true;
    // Order matters: reviewOpenGaps claims the gaps history did cover, and
    // whatever is still open after it is the silence.
    this.runReview();
    const settled = this.detector.settleQuietGaps();
    if (settled > 0) {
      this.log(`🕳️  Gaps closed as quiet (no evidence of missed traffic): ${settled}`);
    }
  }

  private schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    // A pending review must never be the reason the process stays alive.
    timer.unref?.();
    return timer;
  }

  private clearTimer(which: "review" | "settle"): void {
    const timer = which === "review" ? this.reviewTimer : this.settleTimer;
    if (!timer) return;
    clearTimeout(timer);
    if (which === "review") this.reviewTimer = null;
    else this.settleTimer = null;
  }
}
