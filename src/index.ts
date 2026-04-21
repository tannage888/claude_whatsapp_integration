import express from "express";
import { config } from "./config.js";
import { createApiRouter } from "./routes/api.js";
import { WhatsAppConnection } from "./services/whatsapp.js";
import { StateDb } from "./services/state-db.js";
import { NoReadService } from "./services/no-read.js";
import { MembershipService } from "./services/membership.js";
import { ContactContextScraper } from "./services/contact-context-scraper.js";
import { ZipAutoDetector } from "./services/zip-auto-detector.js";
import type { proto } from "@whiskeysockets/baileys";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const startedAt = Date.now();

  // ── Initialise services ────────────────────────────────────

  const db = new StateDb(config.STATE_DB_PATH);
  const wa = new WhatsAppConnection(config.MESSAGE_STORE_PATH);
  const noRead = new NoReadService(db, wa.store);
  const membership = new MembershipService(db, () => wa.getSocket(), config.MEMBERSHIP_REFRESH_HOURS);
  const contextScraper = new ContactContextScraper(db, wa.store, membership, () => wa.getSocket());

  const zipDetector = new ZipAutoDetector(wa.store, db, () => wa.getSocket(), {
    disabled: process.env.DISABLE_AUTO_ZIP_IMPORT === "true",
    onImport: (r) => {
      console.log(`📦 ZIP auto-import: imported=${r.imported} duplicates=${r.duplicates} file="${r.textFile}"`);
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
