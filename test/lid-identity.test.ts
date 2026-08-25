/**
 * Identity harvesting and lid-aware membership lookup.
 *
 * WhatsApp addresses group participants by @lid. Every message key carries
 * the phone-number form alongside it, but the daemon used to discard it —
 * leaving membership rows written under lids and lookups done by phone JID,
 * so /api/contacts/:id/chats returned empty for everyone.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MessageStore } from "../src/services/message-store.js";
import { StateDb } from "../src/services/state-db.js";
import { MembershipService } from "../src/services/membership.js";

const LID = "231395758719056@lid";
const PHONE = "447931460181@s.whatsapp.net";
const GROUP = "120363160889292336@g.us";

function msg(key: Record<string, unknown>) {
  return { key, message: { conversation: "hi" } } as any;
}

describe("MessageStore identity harvesting", () => {
  let store: MessageStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lid-"));
    store = new MessageStore(path.join(tmpDir, "store.json"));
  });

  it("learns a lid→phone pair from a group message key", () => {
    store.buffer([msg({ remoteJid: GROUP, participantLid: LID, participantPn: PHONE })]);

    expect(store.phoneForLid(LID)).toBe(PHONE);
    expect(store.lidForPhone(PHONE)).toBe(LID);
  });

  it("learns from senderLid/senderPn on a direct message", () => {
    store.buffer([msg({ remoteJid: PHONE, senderLid: LID, senderPn: PHONE })]);

    expect(store.phoneForLid(LID)).toBe(PHONE);
  });

  it("treats a lid-shaped participant field as the lid", () => {
    store.buffer([msg({ remoteJid: GROUP, participant: LID, participantPn: PHONE })]);

    expect(store.phoneForLid(LID)).toBe(PHONE);
  });

  it("ignores keys carrying only one half of the pair", () => {
    store.buffer([
      msg({ remoteJid: GROUP, participantLid: LID }),
      msg({ remoteJid: GROUP, participantPn: PHONE }),
      msg({ remoteJid: GROUP }),
    ]);

    expect(store.lidMappingSize).toBe(0);
  });

  it("does not treat a phone JID as a lid", () => {
    store.buffer([msg({ remoteJid: GROUP, participantLid: PHONE, participantPn: PHONE })]);

    expect(store.lidMappingSize).toBe(0);
  });

  it("survives a save/load round trip", () => {
    const storePath = path.join(tmpDir, "roundtrip.json");
    const first = new MessageStore(storePath);
    first.buffer([msg({ remoteJid: GROUP, participantLid: LID, participantPn: PHONE })]);
    first.save();

    const second = new MessageStore(storePath);
    second.load();

    expect(second.phoneForLid(LID)).toBe(PHONE);
  });
});

describe("Membership lookup across both identifiers", () => {
  let db: StateDb;
  let store: MessageStore;
  let ms: MembershipService;

  beforeEach(() => {
    db = new StateDb(":memory:");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lid-ms-"));
    store = new MessageStore(path.join(tmpDir, "store.json"));
    ms = new MembershipService(db, () => null, 24, store);
  });

  it("finds a lid-recorded group when looking up by phone number", () => {
    // How every existing row was written: participant id is the lid.
    ms.recordMember(GROUP, LID, null);
    store.registerLid(LID, PHONE);

    const result = ms.getChatsForContact("+447931460181");

    expect(result.chats.map((c) => c.chatJid)).toContain(GROUP);
  });

  it("returns nothing when the pairing is unknown", () => {
    ms.recordMember(GROUP, LID, null);

    expect(ms.getChatsForContact("+447931460181").chats).toEqual([]);
  });

  it("still finds a group recorded under the phone JID", () => {
    ms.recordMember(GROUP, PHONE, null);

    expect(ms.getChatsForContact("+447931460181").chats).toHaveLength(1);
  });

  it("does not list a group twice when both ids are recorded", () => {
    ms.recordMember(GROUP, LID, null);
    ms.recordMember(GROUP, PHONE, null);
    store.registerLid(LID, PHONE);

    expect(ms.getChatsForContact("+447931460181").chats).toHaveLength(1);
  });

  it("falls back to the chats table for the group name", () => {
    // A metadata refresh writes membership rows with a null display_name;
    // without the join callers get a bare JID they cannot show anyone.
    db.upsertChat({ jid: GROUP, displayName: "Judd SEND parents", isGroup: true });
    ms.recordMember(GROUP, PHONE, null);

    expect(ms.getChatsForContact("+447931460181").chats[0].displayName).toBe("Judd SEND parents");
  });

  it("resolves a lid identifier back to its phone-recorded groups", () => {
    ms.recordMember(GROUP, PHONE, null);
    store.registerLid(LID, PHONE);

    expect(ms.getChatsForContact(LID).chats).toHaveLength(1);
  });
});
