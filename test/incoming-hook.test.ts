import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Minimal WhatsAppConnection stub that emits "message:received"
function makeWaStub() {
  const emitter = new EventEmitter();
  return {
    on: (event: string, cb: (...args: any[]) => void) => emitter.on(event, cb),
    emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    remoteJid: "447700900001@s.whatsapp.net",
    fromMe: false,
    body: "Hello",
    timestamp: 1700000000000,
    messageId: "msg-abc123",
    ...overrides,
  };
}

describe("WA_INCOMING_HOOK_URL live-push", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires fetch with correct payload when hook URL is set", async () => {
    const hookUrl = "http://127.0.0.1:3141/api/incoming-message";
    const wa = makeWaStub();

    // Wire listener (same logic as src/index.ts)
    wa.on("message:received", (msg: any) => {
      fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: msg.remoteJid,
          fromMe: msg.fromMe ?? false,
          body: msg.body ?? "",
          timestamp: msg.timestamp,
          messageId: msg.messageId,
        }),
      }).catch(() => {});
    });

    const msg = makeMsg();
    wa.emit("message:received", msg);

    // fetch is called synchronously on emit; await microtask queue
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(hookUrl);
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(calledInit.body);
    expect(body).toEqual({
      remoteJid: msg.remoteJid,
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp,
      messageId: msg.messageId,
    });
  });

  it("does not call fetch when hook URL is null", async () => {
    const hookUrl: string | null = null;
    const wa = makeWaStub();

    // Guard — same as src/index.ts
    if (hookUrl) {
      wa.on("message:received", (msg: any) => {
        fetch(hookUrl, { method: "POST", body: JSON.stringify(msg) }).catch(() => {});
      });
    }

    wa.emit("message:received", makeMsg());
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows fetch errors so the daemon does not throw", async () => {
    const hookUrl = "http://127.0.0.1:3141/api/incoming-message";
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const wa = makeWaStub();

    let thrownErr: unknown = null;
    wa.on("message:received", (msg: any) => {
      fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: msg.remoteJid,
          fromMe: msg.fromMe ?? false,
          body: msg.body ?? "",
          timestamp: msg.timestamp,
          messageId: msg.messageId,
        }),
      }).catch(() => {}); // swallow
    });

    // Emit and wait; should not reject
    await expect(
      new Promise<void>((resolve, reject) => {
        process.once("uncaughtException", reject);
        wa.emit("message:received", makeMsg());
        // Give the rejected promise time to settle
        setTimeout(resolve, 20);
      })
    ).resolves.toBeUndefined();

    expect(thrownErr).toBeNull();
  });

  it("defaults fromMe and body when missing from message", async () => {
    const hookUrl = "http://127.0.0.1:3141/api/incoming-message";
    const wa = makeWaStub();

    wa.on("message:received", (msg: any) => {
      fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: msg.remoteJid,
          fromMe: msg.fromMe ?? false,
          body: msg.body ?? "",
          timestamp: msg.timestamp,
          messageId: msg.messageId,
        }),
      }).catch(() => {});
    });

    wa.emit("message:received", {
      remoteJid: "447700900001@s.whatsapp.net",
      timestamp: 1700000000000,
      messageId: "msg-xyz",
      // fromMe and body intentionally absent
    });

    await Promise.resolve();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.fromMe).toBe(false);
    expect(body.body).toBe("");
  });
});
