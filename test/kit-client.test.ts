import { describe, it, expect, vi } from "vitest";
import { KitClient } from "../src/services/kit-client.js";

const KIT = "http://127.0.0.1:3141";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

describe("KitClient.resolveContactName", () => {
  it("returns the JID when Kit knows the contact", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ jid: "447700900001@s.whatsapp.net", contactId: "c1" })
      );
    const client = new KitClient(KIT, fetchFn as any);

    const jid = await client.resolveContactName("Alice Smith");

    expect(jid).toBe("447700900001@s.whatsapp.net");
    expect(fetchFn).toHaveBeenCalledWith(`${KIT}/api/contacts/resolve-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Smith" }),
    });
  });

  it("returns null when Kit responds with jid: null", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jid: null, contactId: null }));
    const client = new KitClient(KIT, fetchFn as any);

    expect(await client.resolveContactName("Nobody")).toBeNull();
  });

  it("returns null when Kit returns non-2xx", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 500));
    const client = new KitClient(KIT, fetchFn as any);

    expect(await client.resolveContactName("Alice")).toBeNull();
  });

  it("returns null and logs a warning on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new KitClient(KIT, fetchFn as any);

    expect(await client.resolveContactName("Alice")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("KitClient.notifyImportComplete", () => {
  it("POSTs the import notification to Kit", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: "ok" }));
    const client = new KitClient(KIT, fetchFn as any);

    await client.notifyImportComplete({
      chatJid: "447700900001@s.whatsapp.net",
      imported: 12,
      duplicates: 3,
      textFile: "WhatsApp Chat with Alice.txt",
    });

    expect(fetchFn).toHaveBeenCalledWith(
      `${KIT}/api/zip-import-complete`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body).toEqual({
      chatJid: "447700900001@s.whatsapp.net",
      imported: 12,
      duplicates: 3,
      textFile: "WhatsApp Chat with Alice.txt",
    });
  });

  it("swallows network errors so the daemon stays up", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new KitClient(KIT, fetchFn as any);

    await expect(
      client.notifyImportComplete({ chatJid: "1@s.whatsapp.net" })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
