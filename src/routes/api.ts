import { Router } from "express";
import { z } from "zod";
import type { ConnectionStatus, DaemonStatus } from "../types.js";
import type { WhatsAppConnection } from "../services/whatsapp.js";
import type { StateDb } from "../services/state-db.js";
import type { NoReadService } from "../services/no-read.js";
import { buildTranscript } from "../services/read.js";
import type { ReadMode } from "../services/read.js";
import { sendMessages, SendRequestSchema } from "../services/send.js";
import type { MembershipService } from "../services/membership.js";
import { importPhoneExport } from "../services/phone-export-importer.js";
import { importZipExport, ZipImportError } from "../services/zip-export-importer.js";
import type { ContactContextScraper } from "../services/contact-context-scraper.js";
import type { KitClient } from "../services/kit-client.js";
import multer from "multer";

interface RouterDeps {
  startedAt: number;
  getConnectionStatus: () => ConnectionStatus;
  version: string;
  whatsapp?: WhatsAppConnection;
  db?: StateDb;
  noRead?: NoReadService;
  membership?: MembershipService;
  contextScraper?: ContactContextScraper;
  authStatePath?: string;
  kit?: KitClient;
}

const ScrapeContextBody = z.object({
  maxMessagesPerChat: z.number().int().positive().max(5000).optional(),
  since: z.string().datetime().optional(),
});

const AckBody = z.object({ watermark: z.string().datetime() });
const NoReadAddBody = z.object({ identifier: z.string().min(1) });

export function createApiRouter(deps: RouterDeps): Router {
  const router = Router();

  // ── Status ────────────────────────────────────────────────

  router.get("/status", (_req, res) => {
    const body: DaemonStatus = {
      status: "ok",
      connection: deps.getConnectionStatus(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      startedAt: new Date(deps.startedAt).toISOString(),
      version: deps.version,
    };
    res.json(body);
  });

  // ── Auth ──────────────────────────────────────────────────

  router.get("/auth/status", (_req, res) => {
    res.json({ status: deps.getConnectionStatus() });
  });

  router.get("/auth/qr", (_req, res) => {
    const wa = deps.whatsapp;
    if (!wa) return res.status(503).json({ error: "whatsapp_not_initialised" });
    const status = wa.getStatus();
    if (status !== "qr_ready") {
      return res.status(409).json({ error: "qr_not_available", status });
    }
    return res.json({ qr: wa.getQr(), pairingCode: wa.getPairingCode() });
  });

  router.delete("/auth", (_req, res) => {
    const wa = deps.whatsapp;
    const authStatePath = deps.authStatePath;
    if (!wa || !authStatePath) {
      return res.status(503).json({ error: "whatsapp_not_initialised" });
    }
    wa.wipeAuthState(authStatePath);
    return res.json({ ok: true });
  });

  // ── Chats / Read ──────────────────────────────────────────

  router.get("/chats", (_req, res) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: "db_not_initialised" });
    res.json({ chats: db.listChats() });
  });

  router.get("/chats/:jid/messages", (req, res) => {
    const wa = deps.whatsapp;
    const db = deps.db;
    if (!wa || !db) return res.status(503).json({ error: "not_initialised" });

    const { jid } = req.params;
    const { mode: modeParam, from: fromParam, to: toParam } = req.query as Record<string, string | undefined>;

    let mode: ReadMode = "since_last_review";
    if (modeParam === "full") mode = "full";
    else if (fromParam && toParam) mode = "from_to";
    else if (fromParam) mode = "from";

    const from = fromParam ? new Date(fromParam).getTime() : undefined;
    const to = toParam ? new Date(toParam).getTime() : undefined;

    const transcript = buildTranscript({ jid, mode, from, to }, wa.store, db);
    return res.json(transcript);
  });

  router.post("/chats/:jid/ack", (req, res) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: "db_not_initialised" });

    const parse = AckBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "invalid_body", details: parse.error.issues });

    const { jid } = req.params;
    const ts = new Date(parse.data.watermark).getTime();
    db.setWatermark(jid, ts);
    return res.json({ ok: true, chatJid: jid, watermark: parse.data.watermark });
  });

  // ── Gaps ─────────────────────────────────────────────────

  router.get("/gaps", (_req, res) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: "db_not_initialised" });
    const gaps = db.listGaps();
    return res.json({ gaps });
  });

  router.post("/gaps/:id/resolve", (req, res) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: "db_not_initialised" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid_gap_id" });
    const gap = db.getGap(id);
    if (!gap) return res.status(404).json({ error: "gap_not_found" });
    db.resolveGap(id);
    return res.json({ ok: true });
  });

  // ── Contacts / Membership ─────────────────────────────────

  router.get("/contacts/:identifier/chats", (req, res) => {
    const ms = deps.membership;
    if (!ms) return res.status(503).json({ error: "membership_not_initialised" });
    const result = ms.getChatsForContact(req.params.identifier);
    return res.json(result);
  });

  router.post("/contacts/refresh", async (_req, res) => {
    const ms = deps.membership;
    if (!ms) return res.status(503).json({ error: "membership_not_initialised" });
    const result = await ms.refresh();
    return res.json(result);
  });

  router.post("/contacts/:identifier/scrape-context", async (req, res) => {
    const scraper = deps.contextScraper;
    if (!scraper) return res.status(503).json({ error: "context_scraper_not_initialised" });

    const parse = ScrapeContextBody.safeParse(req.body ?? {});
    if (!parse.success) return res.status(400).json({ error: "invalid_body", details: parse.error.issues });

    try {
      const result = await scraper.scrape(req.params.identifier, parse.data);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: "scrape_failed", message: (e as Error).message });
    }
  });

  // ── No-read list ──────────────────────────────────────────

  router.get("/no-read", (_req, res) => {
    const nr = deps.noRead;
    if (!nr) return res.status(503).json({ error: "no_read_not_initialised" });
    res.json({ entries: nr.list() });
  });

  router.post("/no-read", (req, res) => {
    const nr = deps.noRead;
    if (!nr) return res.status(503).json({ error: "no_read_not_initialised" });

    const parse = NoReadAddBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "invalid_body", details: parse.error.issues });

    const result = nr.add(parse.data.identifier);
    return res.status(201).json(result);
  });

  // ── Send ──────────────────────────────────────────────────

  router.post("/send", async (req, res) => {
    const wa = deps.whatsapp;
    if (!wa) return res.status(503).json({ error: "whatsapp_not_initialised" });

    const parse = SendRequestSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "invalid_body", details: parse.error.issues });

    const results = await sendMessages(parse.data.messages, () => wa.getSocket());
    return res.json({ results });
  });

  // ── No-read list ──────────────────────────────────────────

  router.delete("/no-read/:jid", (req, res) => {
    const nr = deps.noRead;
    if (!nr) return res.status(503).json({ error: "no_read_not_initialised" });
    nr.remove(req.params.jid);
    return res.json({ ok: true });
  });

  // ── Phone-export import ───────────────────────────────────

  const upload = multer({ storage: multer.memoryStorage() });

  router.post("/import/phone-export", upload.single("file"), async (req, res) => {
    const wa = deps.whatsapp;
    const db = deps.db;
    if (!wa || !db) return res.status(503).json({ error: "not_initialised" });

    const chatJid = (req.body?.jid as string) || (req.query.jid as string);
    if (!chatJid) return res.status(400).json({ error: "missing_jid" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "missing_file" });

    const text = file.buffer.toString("utf-8");
    const contactName = db.getChat(chatJid)?.displayName ?? null;
    const result = await importPhoneExport(text, chatJid, wa.store, db, contactName);
    return res.json(result);
  });

  // ── ZIP export import ─────────────────────────────────────

  router.post("/import/zip-export", upload.single("file"), async (req, res) => {
    const wa = deps.whatsapp;
    const db = deps.db;
    if (!wa || !db) return res.status(503).json({ error: "not_initialised" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "missing_file" });

    const chatJid = (req.body?.chatJid as string) || (req.body?.jid as string) || (req.query.chatJid as string) || (req.query.jid as string) || undefined;

    try {
      const nameResolver = deps.kit
        ? (name: string) => deps.kit!.resolveContactName(name)
        : undefined;
      const result = await importZipExport(file.buffer, chatJid, wa.store, db, nameResolver);

      // Mirror the auto-detector path: tell Kit so it can pull the new
      // transcript and queue a /kit-captures review card.
      const resolved = chatJid ?? result.inferredChatJid;
      if (deps.kit && resolved) {
        void deps.kit.notifyImportComplete({
          chatJid: resolved,
          imported: result.imported,
          duplicates: result.duplicates,
          textFile: result.textFile,
        });
      }

      return res.json(result);
    } catch (e) {
      if (e instanceof ZipImportError) {
        return res.status(400).json({ error: e.code, message: e.message });
      }
      return res.status(500).json({ error: "zip_import_failed", message: (e as Error).message });
    }
  });

  return router;
}
