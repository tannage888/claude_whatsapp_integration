import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GapReviewScheduler } from "../src/services/gap-review-scheduler.js";
import type { GapDetector } from "../src/services/gap-detector.js";

const SETTLE_MS = 60_000;
const DEBOUNCE_MS = 5_000;

describe("GapReviewScheduler", () => {
  let reviewOpenGaps: ReturnType<typeof vi.fn>;
  let settleQuietGaps: ReturnType<typeof vi.fn>;
  let logged: string[];

  function makeScheduler() {
    const detector = { reviewOpenGaps, settleQuietGaps } as unknown as GapDetector;
    return new GapReviewScheduler(detector, {
      settleDelayMs: SETTLE_MS,
      reviewDebounceMs: DEBOUNCE_MS,
      log: (m) => logged.push(m),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reviewOpenGaps = vi.fn().mockReturnValue(0);
    settleQuietGaps = vi.fn().mockReturnValue(0);
    logged = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reviews and settles after connecting, with no history at all", async () => {
    // The regression this class exists for. WhatsApp sends history only on the
    // initial sync at pairing, so an ordinary restart produces no batches — and
    // the old history-driven wiring therefore never ran in production.
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();

    expect(reviewOpenGaps).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(reviewOpenGaps).toHaveBeenCalledTimes(1);
    expect(settleQuietGaps).toHaveBeenCalledTimes(1);
  });

  it("does not settle before the deadline", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();

    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);

    expect(settleQuietGaps).not.toHaveBeenCalled();
  });

  it("reviews on the trailing edge of a burst of history batches", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();

    scheduler.onHistoryBatch(false);
    scheduler.onHistoryBatch(false);
    scheduler.onHistoryBatch(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(reviewOpenGaps).toHaveBeenCalledTimes(1);
    expect(settleQuietGaps).not.toHaveBeenCalled();
  });

  it("pushes the settle deadline back while history is still arriving", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();

    // A batch just before the deadline must not let silence be declared on time.
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1_000);
    scheduler.onHistoryBatch(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settleQuietGaps).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(settleQuietGaps).toHaveBeenCalledTimes(1);
  });

  it("settles immediately when WhatsApp reports the sync complete", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();

    scheduler.onHistoryBatch(true);

    expect(settleQuietGaps).toHaveBeenCalledTimes(1);
    // No need to wait out the deadline once WhatsApp has said that is the lot.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reviews before settling, so recovered gaps are claimed first", async () => {
    const order: string[] = [];
    reviewOpenGaps.mockImplementation(() => {
      order.push("review");
      return 0;
    });
    settleQuietGaps.mockImplementation(() => {
      order.push("settle");
      return 0;
    });

    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(order).toEqual(["review", "settle"]);
  });

  it("settles once per connection, not once per later batch", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(settleQuietGaps).toHaveBeenCalledTimes(1);

    // Late traffic still gets reviewed, but silence is not re-declared.
    scheduler.onHistoryBatch(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);

    expect(settleQuietGaps).toHaveBeenCalledTimes(1);
    expect(reviewOpenGaps.mock.calls.length).toBeGreaterThan(1);
  });

  it("arms a fresh deadline when the socket reconnects", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(settleQuietGaps).toHaveBeenCalledTimes(1);

    scheduler.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(settleQuietGaps).toHaveBeenCalledTimes(2);
  });

  it("reports only the passes that changed something", async () => {
    reviewOpenGaps.mockReturnValue(3);
    settleQuietGaps.mockReturnValue(0);

    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(logged).toEqual(["🕳️  Gaps closed by history sync: 3"]);
  });

  it("stop() cancels pending work", async () => {
    const scheduler = makeScheduler();
    scheduler.onConnectionOpen();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);

    expect(reviewOpenGaps).not.toHaveBeenCalled();
    expect(settleQuietGaps).not.toHaveBeenCalled();
  });
});
