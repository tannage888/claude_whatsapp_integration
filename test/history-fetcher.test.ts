import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { HistoryFetcher, oldestAnchor } from "../src/services/history-fetcher.js";
import type { WASocket } from "@whiskeysockets/baileys";

const JID = "447700900123@s.whatsapp.net";
const SESSION_ID = "peer-session-1";

const ANCHOR = {
  key: { remoteJid: JID, fromMe: false, id: "ANCHOR1" },
  timestampSec: 1_700_000_000,
};

function makeMsg(id: string, tsSec: number) {
  return {
    key: { remoteJid: JID, fromMe: false, id },
    message: { conversation: id },
    messageTimestamp: tsSec,
  };
}

/**
 * A socket with the REAL fetchMessageHistory contract: it resolves to a
 * request-session id string, and the messages arrive separately on
 * `messaging-history.set` tagged with that same id.
 */
function makeSocket(opts: { sessionId?: string; reject?: boolean } = {}) {
  const ev = new EventEmitter();
  const fetchMessageHistory = vi.fn(() =>
    opts.reject ? Promise.reject(new Error("boom")) : Promise.resolve(opts.sessionId ?? SESSION_ID)
  );
  const socket = { ev, fetchMessageHistory } as unknown as WASocket;
  return { socket, ev, fetchMessageHistory };
}

function emitHistory(
  ev: EventEmitter,
  sessionId: string | null,
  messages: ReturnType<typeof makeMsg>[],
  isLatest = false
) {
  ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages,
    isLatest,
    peerDataRequestSessionId: sessionId,
  });
}

describe("HistoryFetcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls fetchMessageHistory with Baileys' argument order (count, key, timestamp)", async () => {
    const { socket, ev, fetchMessageHistory } = makeSocket();
    const fetcher = new HistoryFetcher(() => socket, 1000);

    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.waitFor(() => expect(fetchMessageHistory).toHaveBeenCalled());
    emitHistory(ev, SESSION_ID, []);
    await pending;

    expect(fetchMessageHistory).toHaveBeenCalledWith(50, ANCHOR.key, ANCHOR.timestampSec);
  });

  it("resolves with the batch carrying the matching session id", async () => {
    const { socket, ev } = makeSocket();
    const fetcher = new HistoryFetcher(() => socket, 1000);

    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.waitFor(() => expect(ev.listenerCount("messaging-history.set")).toBe(1));
    emitHistory(ev, SESSION_ID, [makeMsg("a", 1), makeMsg("b", 2)], true);

    const batch = await pending;
    expect(batch.messages).toHaveLength(2);
    expect(batch.isLatest).toBe(true);
    expect(batch.timedOut).toBe(false);
  });

  it("ignores history batches belonging to another request", async () => {
    vi.useFakeTimers();
    const { socket, ev } = makeSocket();
    const fetcher = new HistoryFetcher(() => socket, 1000);

    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.waitFor(() => expect(ev.listenerCount("messaging-history.set")).toBe(1));

    // Someone else's history — and the unsolicited reconnect sync, which
    // carries no session id at all.
    emitHistory(ev, "someone-elses-session", [makeMsg("x", 1)]);
    emitHistory(ev, null, [makeMsg("y", 2)]);

    await vi.advanceTimersByTimeAsync(1000);
    const batch = await pending;
    expect(batch.messages).toHaveLength(0);
    expect(batch.timedOut).toBe(true);
  });

  it("matches a batch that arrives before fetchMessageHistory resolves", async () => {
    const ev = new EventEmitter();
    let releaseSessionId: (id: string) => void = () => {};
    const socket = {
      ev,
      fetchMessageHistory: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseSessionId = resolve;
          })
      ),
    } as unknown as WASocket;

    const fetcher = new HistoryFetcher(() => socket, 1000);
    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.waitFor(() => expect(ev.listenerCount("messaging-history.set")).toBe(1));

    // History lands first; the id it should be matched against is still unknown.
    emitHistory(ev, SESSION_ID, [makeMsg("early", 1)]);
    releaseSessionId(SESSION_ID);

    const batch = await pending;
    expect(batch.messages).toHaveLength(1);
    expect(batch.timedOut).toBe(false);
  });

  it("times out rather than hanging when no history comes back", async () => {
    vi.useFakeTimers();
    const { socket } = makeSocket();
    const fetcher = new HistoryFetcher(() => socket, 5000);

    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.advanceTimersByTimeAsync(5000);

    const batch = await pending;
    expect(batch.timedOut).toBe(true);
    expect(batch.messages).toHaveLength(0);
  });

  it("removes its listener once settled", async () => {
    const { socket, ev } = makeSocket();
    const fetcher = new HistoryFetcher(() => socket, 1000);

    const pending = fetcher.fetchOlderThan(ANCHOR, 50);
    await vi.waitFor(() => expect(ev.listenerCount("messaging-history.set")).toBe(1));
    emitHistory(ev, SESSION_ID, []);
    await pending;

    expect(ev.listenerCount("messaging-history.set")).toBe(0);
  });

  it("returns an empty batch when there is no socket", async () => {
    const fetcher = new HistoryFetcher(() => null, 1000);
    const batch = await fetcher.fetchOlderThan(ANCHOR, 50);

    expect(batch).toEqual({ messages: [], isLatest: false, timedOut: false });
  });

  it("returns an empty batch when the request throws", async () => {
    const { socket, ev } = makeSocket({ reject: true });
    const fetcher = new HistoryFetcher(() => socket, 1000);

    const batch = await fetcher.fetchOlderThan(ANCHOR, 50);

    expect(batch.messages).toHaveLength(0);
    expect(batch.timedOut).toBe(false);
    expect(ev.listenerCount("messaging-history.set")).toBe(0);
  });
});

describe("oldestAnchor", () => {
  let messages: ReturnType<typeof makeMsg>[];

  beforeEach(() => {
    messages = [makeMsg("mid", 200), makeMsg("oldest", 100), makeMsg("newest", 300)];
  });

  it("picks the oldest message regardless of stored order", () => {
    const anchor = oldestAnchor(messages as never);
    expect(anchor?.key.id).toBe("oldest");
    expect(anchor?.timestampSec).toBe(100);
  });

  it("returns null when there is nothing to anchor on", () => {
    expect(oldestAnchor([])).toBeNull();
  });

  it("skips messages with no usable timestamp", () => {
    const anchor = oldestAnchor([
      { key: { remoteJid: JID, id: "no-ts" }, messageTimestamp: 0 },
      makeMsg("real", 500),
    ] as never);
    expect(anchor?.key.id).toBe("real");
  });
});
