// Resolves various identifier formats to a WhatsApp JID

export function e164ToJid(e164: string): string {
  return `${e164.replace(/^\+/, "").replace(/\s+/g, "")}@s.whatsapp.net`;
}

export function jidToE164(jid: string): string {
  return `+${jid.replace(/@s\.whatsapp\.net$/, "")}`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

/**
 * Resolve an identifier to a JID:
 *  - If already a JID (@s.whatsapp.net, @g.us, @lid) — return as-is
 *  - If E164 (+447700900123) — convert to @s.whatsapp.net
 *  - Otherwise — return as-is (display name lookup not attempted here)
 */
export function resolveIdentifier(identifier: string): string {
  if (identifier.includes("@")) return identifier;
  // E164 or bare number
  const digits = identifier.replace(/^\+/, "").replace(/\s+/g, "");
  return `${digits}@s.whatsapp.net`;
}
