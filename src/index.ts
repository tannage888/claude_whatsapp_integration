import express from "express";
import { config } from "./config.js";
import { createApiRouter } from "./routes/api.js";
import { WhatsAppConnection } from "./services/whatsapp.js";
import { StateDb } from "./services/state-db.js";
import { NoReadService } from "./services/no-read.js";
import { MembershipService } from "./services/membership.js";
import { ContactContextScraper } from "./services/contact-context-scraper.js";
import { ZipAutoDetector } from "./services/zip-auto-detector.js";
import { KitClient } from "./services/kit-client.js";
import { GapDetector } from "./services/gap-detector.js";
import { SessionHealth } from "./services/session-health.js";
import type { proto } from "@whiskeysockets/baileys";

const VERSION = "0.1.0";
const GAP_REVIEW_DEBOUNCE_MS = 5_000;

async function main(): Promise<void> {
  const startedAt = Date.now();

  // ── Initialise services ────────────────────────────────────

  const db = new StateDb(config.STATE_DB_PATH);
  const wa = new WhatsAppConnection(config.MESSAGE_STORE_PATH);
  const noRead = new NoReadService(db, wa.store);
  const membership = new MembershipService(db, () => wa.getSocket(), config.MEMBERSHIP_REFRESH_HOURS, wa.store);
  const contextScraper = new ContactContextScraper(db, wa.store, membership, () => wa.getSocket());
  const gapDetector = new GapDetector(db, wa.store);

  // A broken Signal session drops every message in a chat without raising
  // anything, so record it as a gap — the same channel an offline daemon
  // uses — and delete the session so the next message renegotiates.
  const sessionHealth = new SessionHealth(config.AUTH_STATE_PATH, {
    onBroken: (entry) => {
      console.error(
        `🔐 Session broken for ${entry.identity} (${entry.chatJid ?? "unknown chat"}) — ` +
          `${entry.failures} undecryptable messages since ${new Date(entry.firstFailureAt).toISOString()}. Healing.`
      );
      db.recordGap({
        chatJid: entry.chatJid,
        fromTs: entry.firstFailureAt,
        toTs: entry.lastFailureAt,
        reason: "decrypt_failure",
        backfillAttempted: false,
        backfillSucceeded: false,
      });
    },
  });

  wa.on("message:undecryptable", ({ chatJid, senderJid }: { chatJid: string | null; senderJid: string | null }) => {
    if (!chatJid) return;
    sessionHealth.recordFailure(chatJid, senderJid);
  });

  wa.on("message:decrypted", ({ chatJid, senderJid }: { chatJid: string; senderJid: string | null }) => {
    sessionHealth.recordSuccess(chatJid, senderJid);
    gapDetector.touchChat(chatJid);
  });

  // Kit gateway client — handles name→JID resolution (NameResolver fallback
  // when the daemon's chats table doesn't know the contact) and the
  // import-complete webhook so Kit can pull new transcripts into its
  // /kit-captures review queue.
  const kit = new KitClient(config.KIT_GATEWAY_URL);

  const zipDetector = new ZipAutoDetector(wa.store, db, () => wa.getSocket(), {
    disabled: process.env.DISABLE_AUTO_ZIP_IMPORT === "true",
    nameResolver: (name) => kit.resolveContactName(name),
    onImport: (r) => {
      console.log(`📦 ZIP auto-import: imported=${r.imported} duplicates=${r.duplicates} file="${r.textFile}"`);
      if (r.inferredChatJid) {
        void kit.notifyImportComplete({
          chatJid: r.inferredChatJid,
          imported: r.imported,
          duplicates: r.duplicates,
          textFile: r.textFile,
        });
      }
    },
    onError: (e) => {
      console.error(`📦 ZIP auto-import failed: ${e.message}`);
    },
  });

  // Wire membership tracking into incoming group messages
  wa.on("message:received", (msg: any) => {
    if (msg.remoteJid?.endsWith("@g.us") && msg.participantJid) {
      membership.recordMember(msg.remoteJid, msg.participantJid, null);
    }
  });

  // Forward incoming messages to Kit's live-push endpoint (best-effort)
  if (config.WA_INCOMING_HOOK_URL) {
    const hookUrl = config.WA_INCOMING_HOOK_URL;
    wa.on("message:received", (msg: any) => {
      fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid:  msg.remoteJid,
          fromMe:     msg.fromMe ?? false,
          body:       msg.body ?? "",
          timestamp:  msg.timestamp,
          messageId:  msg.messageId,
        }),
      }).catch(() => {}); // best-effort; Kit outage must not crash the daemon
    });
  }

  // Wire ZIP auto-detection into every incoming raw message
  if (!zipDetector.disabled) {
    wa.on("message:raw", (raw: proto.IWebMessageInfo) => {
      if (zipDetector.shouldProcess(raw)) {
        zipDetector.handle(raw).catch(() => {});
      }
    });
  }

  // ── Start WhatsApp connection ──────────────────────────────

  wa.on("qr:pairing", (code: string) => {
    console.log(`\n📱 WhatsApp pairing code: ${code}\n`);
    console.log("   On your phone: Settings → Linked Devices → Link with phone number");
    console.log("   Enter the code above.\n");
  });

  wa.on("connection:status", (status: string) => {
    console.log(`📡 WhatsApp status: ${status}`);
  });

  await wa.connect();

  // Anything missed while the daemon was down is a gap. Record it now that the
  // socket is live, rather than discovering the hole weeks later.
  wa.once("connection:open", () => {
    try {
      const { gapsRecorded, alreadyCovered } = gapDetector.detect();
      if (gapsRecorded > 0) {
        console.log(`🕳️  Gaps detected: ${gapsRecorded} (${alreadyCovered} already covered)`);
      }
    } catch (e) {
      console.error(`Gap detection failed: ${(e as Error).message}`);
    }
  });

  // Reconnect history arrives in batches over the seconds after the socket
  // opens; each one can close an open gap. Re-check on the trailing edge so a
  // burst of batches costs one pass rather than one per batch.
  let gapReviewTimer: ReturnType<typeof setTimeout> | null = null;
  wa.on("history:set", () => {
    if (gapReviewTimer) clearTimeout(gapReviewTimer);
    gapReviewTimer = setTimeout(() => {
      gapReviewTimer = null;
      try {
        const closed = gapDetector.reviewOpenGaps();
        if (closed > 0) console.log(`🕳️  Gaps closed by history sync: ${closed}`);
      } catch (e) {
        console.error(`Gap review failed: ${(e as Error).message}`);
      }
    }, GAP_REVIEW_DEBOUNCE_MS);
    gapReviewTimer.unref?.();
  });

  // ── REST API ───────────────────────────────────────────────

  const app = express();
  app.use(express.json());

  const apiRouter = createApiRouter({
    startedAt,
    version: VERSION,
    getConnectionStatus: () => wa.getStatus(),
    whatsapp: wa,
    db,
    noRead,
    membership,
    contextScraper,
    authStatePath: config.AUTH_STATE_PATH,
    kit,
    sessionHealth,
  });
  app.use("/api", apiRouter);

  app.get("/", (_req, res) => res.redirect("/api/status"));

  app.listen(config.PORT, config.BIND_ADDRESS, () => {
    console.log(
      `\nWhatsApp gateway v${VERSION} listening on http://${config.BIND_ADDRESS}:${config.PORT}`
    );
    console.log(`Status: GET /api/status`);
  });

  // ── Graceful shutdown ──────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received — shutting down`);
    membership.stopScheduledRefresh();
    await wa.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
