import "dotenv/config";

export interface Config {
  PORT: number;
  BIND_ADDRESS: string;
  WA_GATEWAY_TOKEN: string | null;
  WHATSAPP_PHONE: string | null;
  AUTH_STATE_PATH: string;
  STATE_DB_PATH: string;
  MESSAGE_STORE_PATH: string;
  BACKFILL_MAX_MESSAGES_PER_CHAT: number;
  MEMBERSHIP_REFRESH_HOURS: number;
  LOG_LEVEL: string;
  KIT_GATEWAY_URL: string;
  WA_INCOMING_HOOK_URL: string | null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for env var ${name}: ${raw}`);
  }
  return parsed;
}

function strEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function nullableStrEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return null;
  return raw;
}

export const config: Config = {
  PORT: intEnv("PORT", 3100),
  BIND_ADDRESS: strEnv("BIND_ADDRESS", "127.0.0.1"),
  WA_GATEWAY_TOKEN: nullableStrEnv("WA_GATEWAY_TOKEN"),
  WHATSAPP_PHONE: nullableStrEnv("WHATSAPP_PHONE"),
  AUTH_STATE_PATH: strEnv("AUTH_STATE_PATH", "./auth_state"),
  STATE_DB_PATH: strEnv("STATE_DB_PATH", "./state.db"),
  MESSAGE_STORE_PATH: strEnv("MESSAGE_STORE_PATH", "./auth_state/wa_store.json"),
  BACKFILL_MAX_MESSAGES_PER_CHAT: intEnv("BACKFILL_MAX_MESSAGES_PER_CHAT", 500),
  MEMBERSHIP_REFRESH_HOURS: intEnv("MEMBERSHIP_REFRESH_HOURS", 24),
  LOG_LEVEL: strEnv("LOG_LEVEL", "info"),
  KIT_GATEWAY_URL: nullableStrEnv("KIT_GATEWAY_URL") ?? "http://127.0.0.1:3141",
  WA_INCOMING_HOOK_URL: nullableStrEnv("WA_INCOMING_HOOK_URL"),
};
