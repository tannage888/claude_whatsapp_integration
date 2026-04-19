import { z } from "zod";
import { isGroupJid, resolveIdentifier } from "../utils/jid.js";
import type { WASocket } from "@whiskeysockets/baileys";

export const SendMessageSchema = z.object({
  to: z.string().min(1),
  text: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
});

export const SendRequestSchema = z.object({
  messages: z.array(SendMessageSchema).min(1),
});

export type SendMessage = z.infer<typeof SendMessageSchema>;
export type SendRequest = z.infer<typeof SendRequestSchema>;

export interface SendResult {
  to: string;
  status: "sent" | "failed" | "dry_run";
  messageId?: string;
  error?: string;
}

const INTER_MESSAGE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendMessages(
  messages: SendMessage[],
  getSocket: () => WASocket | null
): Promise<SendResult[]> {
  const results: SendResult[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const { to, text, dryRun } = msg;

    if (i > 0) await sleep(INTER_MESSAGE_DELAY_MS);

    const jid = resolveIdentifier(to);

    if (isGroupJid(jid)) {
      results.push({ to, status: "failed", error: "unsupported_recipient_type" });
      continue;
    }

    // Basic E164/JID format validation
    const digits = jid.replace(/@s\.whatsapp\.net$/, "");
    if (!/^\d{7,15}$/.test(digits)) {
      results.push({ to, status: "failed", error: "invalid_recipient" });
      continue;
    }

    if (dryRun) {
      results.push({ to, status: "dry_run", messageId: undefined });
      continue;
    }

    const socket = getSocket();
    if (!socket) {
      results.push({ to, status: "failed", error: "not_connected" });
      continue;
    }

    try {
      const result = await socket.sendMessage(jid, { text });
      const messageId = result?.key?.id ?? "";
      results.push({ to, status: "sent", messageId });
    } catch (err) {
      results.push({ to, status: "failed", error: (err as Error).message });
    }
  }

  return results;
}
