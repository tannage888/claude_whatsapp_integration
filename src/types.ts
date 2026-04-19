export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "connected"
  | "logged_out";

export interface DaemonStatus {
  status: "ok" | "degraded";
  connection: ConnectionStatus;
  uptimeSeconds: number;
  startedAt: string;
  version: string;
}

export interface WhatsAppMessage {
  id: string;
  remoteJid: string;
  participantJid: string | null; // sender JID in group messages
  fromMe: boolean;
  body: string;
  timestamp: number; // epoch ms
  type: "text" | "media" | "system";
}
