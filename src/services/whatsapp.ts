import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { EventEmitter } from "node:events";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";
import { MessageStore } from "./message-store.js";
import type { ConnectionStatus, WhatsAppMessage } from "../types.js";

const logger = pino({ level: "silent" });

export class WhatsAppConnection extends EventEmitter {
  private socket: WASocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private pairingCode: string | null = null;
  private qrData: string | null = null;
  readonly store: MessageStore;

  constructor(storePath?: string) {
    super();
    this.store = new MessageStore(storePath ?? config.MESSAGE_STORE_PATH);
    this.store.load();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getPairingCode(): string | null {
    return this.pairingCode;
  }

  getQr(): string | null {
    return this.qrData;
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");

    const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_STATE_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const usePairingCode = !state.creds.registered && !!config.WHATSAPP_PHONE;

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Request the full history dump on link rather than Baileys' default
      // recent-only window. The initial sync fires exactly once per pairing,
      // so this must be set before the device is linked — it is the only
      // chance to recover history predating the link.
      syncFullHistory: true,
    });

    this.socket.ev.on("creds.update", saveCreds);

    this.socket.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts) {
        const phoneJid = c.jid ?? (c.id?.endsWith("@s.whatsapp.net") ? c.id : undefined);
        const lid = c.lid ?? (c.id?.endsWith("@lid") ? c.id : undefined);
        if (lid && phoneJid) {
          this.store.registerLid(lid, phoneJid);
        }
      }
    });

    this.socket.ev.on("messaging-history.set", ({ messages }) => {
      this.store.buffer(messages);
    });

    // Track whether we've already requested a pairing code for this session
    let pairingRequested = false;

    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      // When WA sends a QR, the connection is ready for pairing code request
      if (qr && usePairingCode && !pairingRequested) {
        pairingRequested = true;
        const digits = config.WHATSAPP_PHONE!.replace(/\D/g, "");
        this.socket!.requestPairingCode(digits)
          .then((code) => {
            this.pairingCode = code;
            this.setStatus("qr_ready");
            this.emit("qr:pairing", code);
          })
          .catch((err) => {
            console.error("Pairing code request failed, showing QR instead:", err);
            this.handleQr(qr);
          });
        return;
      }

      if (qr && !usePairingCode) this.handleQr(qr);

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        console.log(`Connection closed — reason code: ${reason}`);
        const loggedOut = reason === DisconnectReason.loggedOut;

        if (loggedOut) {
          this.setStatus("logged_out");
          return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000);
          setTimeout(() => this.connect(), delay);
        } else {
          this.setStatus("disconnected");
        }
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.pairingCode = null;
        this.qrData = null;
        this.setStatus("connected");
        this.store.startAutosave();
        this.emit("connection:open");
      }
    });

    this.socket.ev.on("messages.upsert", ({ messages, type }) => {
      this.store.buffer(messages);

      // Treat both "notify" (real-time) and "append" (multi-device sync of
      // self-sent messages) as live events for the raw hook. Without this,
      // self-sent ZIPs from your phone never reach the auto-detector.
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        // Emit raw proto for hooks that need more than the text-body parser (e.g. ZIP auto-detect)
        this.emit("message:raw", msg);

        const parsed = this.parseMessage(msg);
        if (!parsed) continue;
        this.emit(parsed.fromMe ? "message:sent" : "message:received", parsed);
      }
    });
  }

  async sendMessage(e164Number: string, text: string): Promise<string> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("WhatsApp is not connected");
    }
    const jid = this.e164ToJid(e164Number);
    const result = await this.socket.sendMessage(jid, { text });
    if (!result?.key?.id) throw new Error("No message ID returned");
    return result.key.id;
  }

  async disconnect(): Promise<void> {
    this.store.stopAutosave();
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.setStatus("disconnected");
  }

  wipeAuthState(authStatePath: string): void {
    if (existsSync(authStatePath)) {
      rmSync(authStatePath, { recursive: true, force: true });
      mkdirSync(authStatePath, { recursive: true });
    }
    this.setStatus("disconnected");
  }

  // ── Private ──────────────────────────────────────────────

  private handleQr(qr: string): void {
    this.qrData = qr;
    this.setStatus("qr_ready");
    qrcode.generate(qr, { small: true });
    this.emit("qr:code", qr);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit("connection:status", status);
  }

  private e164ToJid(e164: string): string {
    return `${e164.replace(/^\+/, "")}@s.whatsapp.net`;
  }

  private parseMessage(raw: proto.IWebMessageInfo): WhatsAppMessage | null {
    const remoteJid = raw.key?.remoteJid;
    // NOTE: Groups (@g.us) intentionally NOT filtered — unlike kit gateway
    if (!remoteJid) return null;

    const body =
      raw.message?.conversation ||
      raw.message?.extendedTextMessage?.text ||
      raw.message?.imageMessage?.caption ||
      raw.message?.videoMessage?.caption ||
      null;

    if (!body) return null;

    const isGroup = remoteJid.endsWith("@g.us");
    const participantJid = isGroup ? (raw.key?.participant ?? raw.participant ?? null) : null;

    return {
      id: raw.key?.id ?? "",
      remoteJid,
      participantJid: participantJid as string | null,
      fromMe: raw.key?.fromMe ?? false,
      body,
      timestamp: Number(raw.messageTimestamp ?? 0) * 1000,
      type: "text",
    };
  }
}
