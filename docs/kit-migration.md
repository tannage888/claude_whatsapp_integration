# Migrating kit off its embedded WhatsApp integration

This document describes what needs to change in `kit/gateway` to deprecate its embedded Baileys connection in favour of the standalone `claude_whatsapp_integration` daemon.

---

## Overview

Kit currently embeds a Baileys WebSocket connection inside its gateway process. The new daemon runs separately and exposes everything over REST. Kit becomes a REST client.

```
BEFORE
kit/gateway ─── Baileys WebSocket ──► WhatsApp servers
                 (manages auth, buffers messages)

AFTER
claude_whatsapp_integration ─── Baileys WebSocket ──► WhatsApp servers
           │
           │ REST on 127.0.0.1:3100
           ▼
       kit/gateway  (calls REST, handles threading + capture as before)
```

The WhatsApp account connects once, in the external daemon. Kit never touches Baileys again.

---

## What to delete

### Files

| File | Reason |
|---|---|
| `gateway/src/services/whatsapp.ts` | Entire Baileys wrapper — replaced by REST |
| `gateway/src/services/message-store.ts` | Local message buffer — daemon owns this now |

### package.json dependencies

```
@whiskeysockets/baileys
qrcode-terminal
```

---

## What to refactor

### `config.ts`

Remove:
```
AUTH_STATE_PATH
WHATSAPP_PHONE
```

Add:
```
EXTERNAL_GATEWAY_URL   (default: http://127.0.0.1:3100)
```

### `services/history-fetcher.ts`

This is the load-bearing change. The constructor currently takes a `WhatsAppConnection`; it needs to take an HTTP client instead.

```ts
// BEFORE
constructor(private wa: { getStoredMessages(jid: string): proto.IWebMessageInfo[] }) {}

async fetchSince(jid: string, contact: TrackedContact, sinceMs: number): Promise<ConversationThread[]> {
  const raw = this.wa.getStoredMessages(jid); // proto.IWebMessageInfo[]
  // parse proto objects, filter by sinceMs, group into threads...
}

// AFTER
constructor(private gatewayUrl: string) {}

async fetchSince(jid: string, contact: TrackedContact, sinceMs: number): Promise<ConversationThread[]> {
  const res = await fetch(
    `${this.gatewayUrl}/api/chats/${encodeURIComponent(jid)}/messages?from=${new Date(sinceMs).toISOString()}`
  );
  const { messages } = await res.json();
  // messages are already parsed WhatsAppMessage[] — skip proto parsing
  // group into threads as before using existing groupIntoThreads() logic
}
```

The thread grouping logic (`groupIntoThreads`, silence-gap detection) is **unchanged**. `ConversationThread` type is **unchanged**. Only the data source changes.

### `services/sweep-scheduler.ts`

Remove the `wa: WhatsAppConnection` parameter. Replace the `wa.getStatus() === "connected"` guard with a check against the external gateway:

```ts
// BEFORE
constructor(private wa: WhatsAppConnection, private contacts: ContactRegistry, ...)

async runSweep() {
  if (this.wa.getStatus() !== "connected") {
    return { skipped: true, reason: "whatsapp_disconnected" };
  }
  // ...
}

// AFTER
constructor(private contacts: ContactRegistry, private capture: CapturePipeline, private fetcher: HistoryFetcher) {}

async runSweep() {
  const status = await fetch(`${config.EXTERNAL_GATEWAY_URL}/api/status`).then(r => r.json()).catch(() => null);
  if (status?.connection !== "connected") {
    return { skipped: true, reason: "whatsapp_disconnected" };
  }
  // rest of sweep logic unchanged
}
```

The watermark table (`kit.wa_sweep_state`) and all Supabase interactions are unchanged.

### `routes/api.ts`

**Remove** these three endpoints (no longer meaningful without a local Baileys connection):

```
GET  /api/auth/status
POST /api/send
GET  /api/debug/store
```

**Add** one new endpoint so the external daemon can push live messages:

```ts
const incomingMsgSchema = z.object({
  remoteJid:  z.string(),
  fromMe:     z.boolean(),
  body:       z.string(),
  timestamp:  z.number(),   // epoch ms
  messageId:  z.string(),
});

router.post("/incoming-message", (req, res) => {
  const parsed = incomingMsgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  messageRouter.handleMessage(parsed.data);
  res.json({ ok: true });
});
```

**Update** `GET /api/status` to fetch connection state from the external daemon instead of `wa.getStatus()`:

```ts
router.get("/status", async (_req, res) => {
  const ext = await fetch(`${config.EXTERNAL_GATEWAY_URL}/api/status`)
    .then(r => r.json())
    .catch(() => ({ connection: "unavailable" }));

  res.json({
    connection: ext.connection,   // "connected" | "disconnected" | "unavailable"
    trackedContacts: contacts.size,
    activeThreads: messageRouter.activeThreadCount,
    pendingCaptures: capture.pendingCount,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    lastSweep: sweepScheduler.getLastResult()?.completedAt ?? null,
    nextSweep: sweepScheduler.getNextSweepAt()?.toISOString() ?? null,
  });
});
```

### `index.ts`

Remove the WhatsApp initialisation block and simplify the boot sequence:

```ts
// REMOVE these lines
const wa = new WhatsAppConnection();
await wa.connect();
wa.on("message:received", msg => messageRouter.handleMessage(msg));
wa.on("message:sent",     msg => messageRouter.handleMessage(msg));
wa.on("connection:open",  () => { wa.resolveContactLids(...); sweepScheduler.start(...); });

// REPLACE with
const fetcher = new HistoryFetcher(config.EXTERNAL_GATEWAY_URL);
const sweepScheduler = new SweepScheduler(contacts, capture, fetcher);
sweepScheduler.start(config.SWEEP_INTERVAL_DAYS); // start immediately, no connection gate

// SIMPLIFY graceful shutdown (remove wa.disconnect())
```

---

## What stays completely unchanged

These files have no Baileys dependency and require zero changes:

| File | Why it's safe |
|---|---|
| `services/capture.ts` | Takes `ConversationThread`, calls Claude + Supabase — protocol-agnostic |
| `services/contacts.ts` | In-memory registry loaded from Supabase |
| `services/message-router.ts` | Receives `WhatsAppMessage` events — source is now REST instead of WebSocket, but the handler is identical |
| `services/sync.ts` | Markdown ↔ Supabase sync, unrelated to WhatsApp |
| `types.ts` | All types (`ConversationThread`, `TrackedContact`, `WhatsAppMessage`, etc.) are unchanged |
| All capture routes | `/api/capture/*`, `/api/captures/*` — pure business logic |
| All sweep routes | `/api/sweep/*` — just calls `sweepScheduler.run/status` |
| All contact routes | `/api/contacts/*` — pure registry management |

---

## Wiring up live message push

For live message capture to work, the external daemon needs to know where to push incoming messages. Set this in the daemon's `.env`:

```
WA_INCOMING_HOOK_URL=http://127.0.0.1:3141/api/incoming-message
```

The daemon will POST each incoming `WhatsAppMessage` to that URL as messages arrive. Kit's `MessageRouter` receives them exactly as it did from the WebSocket event — the inactivity timer and auto-capture flow are unchanged.

> **Note:** The incoming message hook is not yet implemented in the daemon (it was out of scope for v1). Until it is, live capture won't fire automatically. Sweep-based capture works immediately since it polls on a schedule.

---

## Environment variable diff

| Variable | Before | After |
|---|---|---|
| `AUTH_STATE_PATH` | Required | **Remove** |
| `WHATSAPP_PHONE` | Optional | **Remove** |
| `EXTERNAL_GATEWAY_URL` | — | Add (default: `http://127.0.0.1:3100`) |

All other env vars (`SUPABASE_URL`, `OPEN_BRAIN_URL`, `ANTHROPIC_API_KEY`, `PORT`, sweep config) are unchanged.

---

## Running both processes

```bash
# Terminal 1 — WhatsApp daemon (always-on, manages the WA connection)
cd projects/claude_whatsapp_integration
npm run dev

# Terminal 2 — kit gateway (can restart freely without losing WA connection)
cd projects/kit/gateway
npm run dev
```

In production, run both under NSSM (Windows) or pm2. The daemon should start before kit, but kit will handle the daemon being temporarily unavailable gracefully (sweep will skip with `whatsapp_disconnected`, live capture will simply not receive pushes until the hook is implemented).
