import type { proto, WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type { MessageStore } from "./message-store.js";
import type { StateDb } from "./state-db.js";
import {
  importZipExport,
  isZipMimeType,
  isWhatsAppExportFilename,
  type NameResolver,
  type ZipImportResult,
} from "./zip-export-importer.js";

const logger = pino({ level: "silent" });

export interface ZipAutoDetectorOptions {
  disabled?: boolean;
  /** Injectable downloader for testing. Defaults to Baileys' downloadMediaMessage. */
  download?: (msg: proto.IWebMessageInfo) => Promise<Buffer>;
  /**
   * Fallback name→JID lookup, used when the daemon's chats table doesn't
   * contain a 1:1 contact matching the export filename. The Kit deployment
   * wires this to its contact registry.
   */
  nameResolver?: NameResolver;
  onImport?: (result: ZipImportResult) => void;
  onError?: (error: Error) => void;
}

export interface HandleResult {
  handled: boolean;
  result?: ZipImportResult;
  error?: string;
}

export class ZipAutoDetector {
  constructor(
    private readonly store: MessageStore,
    private readonly db: StateDb,
    private readonly getSocket: () => WASocket | null,
    private readonly opts: ZipAutoDetectorOptions = {}
  ) {}

  get disabled(): boolean {
    return !!this.opts.disabled;
  }

  shouldProcess(msg: proto.IWebMessageInfo): boolean {
    if (this.opts.disabled) return false;
    if (!msg.key?.fromMe) return false;

    const doc =
      msg.message?.documentMessage ??
      msg.message?.documentWithCaptionMessage?.message?.documentMessage;
    if (!doc) return false;
    if (!isZipMimeType(doc.mimetype ?? null)) return false;
    if (!isWhatsAppExportFilename(doc.fileName ?? null)) return false;
    return true;
  }

  async handle(msg: proto.IWebMessageInfo): Promise<HandleResult> {
    if (!this.shouldProcess(msg)) return { handled: false };

    try {
      const buffer = await this.downloadBuffer(msg);
      // Do NOT pass msg.remoteJid — for self-sent exports remoteJid is your own JID.
      // Let importZipExport infer chatJid from the filename, with the optional
      // resolver as a fallback when the daemon's own chats table can't help.
      const result = await importZipExport(
        buffer,
        undefined,
        this.store,
        this.db,
        this.opts.nameResolver
      );
      this.opts.onImport?.(result);
      return { handled: true, result };
    } catch (e) {
      const err = e as Error;
      this.opts.onError?.(err);
      return { handled: false, error: err.message };
    }
  }

  private async downloadBuffer(msg: proto.IWebMessageInfo): Promise<Buffer> {
    if (this.opts.download) return this.opts.download(msg);

    const socket = this.getSocket();
    // Dynamic import so tests that don't need real Baileys download don't pay for it
    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: logger as any,
        reuploadRequest: socket
          ? (socket as any).updateMediaMessage ?? (async () => msg)
          : (async () => msg),
      }
    );
    return buf as Buffer;
  }
}
