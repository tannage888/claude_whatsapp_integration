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
