import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "../src/services/state-db.js";

describe("Phase 3: SQLite state DB", () => {
  let db: StateDb;

  beforeEach(() => {
    // In-memory SQLite for fast, isolated tests
    db = new StateDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("chat_watermarks", () => {
    it("returns null for unknown chat", () => {
      expect(db.getWatermark("unknown@s.whatsapp.net")).toBeNull();
    });

    it("sets and gets a watermark", () => {
      db.setWatermark("447700900123@s.whatsapp.net", 1_700_000_000_000);
      const wm = db.getWatermark("447700900123@s.whatsapp.net");
      expect(wm).not.toBeNull();
      expect(wm!.chatJid).toBe("447700900123@s.whatsapp.net");
      expect(wm!.lastReviewedAt).toBe(1_700_000_000_000);
    });

    it("updates an existing watermark", () => {
      db.setWatermark("447700900123@s.whatsapp.net", 1_000);
      db.setWatermark("447700900123@s.whatsapp.net", 2_000);
      expect(db.getWatermark("447700900123@s.whatsapp.net")!.lastReviewedAt).toBe(2_000);
    });
  });

  describe("no_read_list", () => {
    it("starts empty", () => {
      expect(db.listNoRead()).toHaveLength(0);
    });

    it("adds and lists entries", () => {
      db.addNoRead("447700900123@s.whatsapp.net", "+447700900123");
      const list = db.listNoRead();
      expect(list).toHaveLength(1);
      expect(list[0].jid).toBe("447700900123@s.whatsapp.net");
      expect(list[0].identifierInput).toBe("+447700900123");
    });

    it("isNoRead returns true for listed JID", () => {
      db.addNoRead("447700900123@s.whatsapp.net", null);
      expect(db.isNoRead("447700900123@s.whatsapp.net")).toBe(true);
    });

    it("isNoRead returns false for unlisted JID", () => {
      expect(db.isNoRead("447700900123@s.whatsapp.net")).toBe(false);
    });

    it("removes an entry", () => {
      db.addNoRead("447700900123@s.whatsapp.net", null);
      db.removeNoRead("447700900123@s.whatsapp.net");
      expect(db.listNoRead()).toHaveLength(0);
      expect(db.isNoRead("447700900123@s.whatsapp.net")).toBe(false);
    });
  });

  describe("chat_members", () => {
    it("upserts and queries member", () => {
      db.upsertChatMember({
        chatJid: "12345@g.us",
        participantJid: "447700900123@s.whatsapp.net",
        displayName: "Alice",
        lastVerifiedAt: 1_700_000_000_000,
      });
      const chats = db.findChatsForParticipant("447700900123@s.whatsapp.net");
      expect(chats).toHaveLength(1);
      expect(chats[0].chatJid).toBe("12345@g.us");
      expect(chats[0].displayName).toBe("Alice");
    });

    it("updates display name on re-upsert", () => {
      db.upsertChatMember({ chatJid: "g1@g.us", participantJid: "p1@s.whatsapp.net", displayName: "Old", lastVerifiedAt: 1000 });
      db.upsertChatMember({ chatJid: "g1@g.us", participantJid: "p1@s.whatsapp.net", displayName: "New", lastVerifiedAt: 2000 });
      const chats = db.findChatsForParticipant("p1@s.whatsapp.net");
      expect(chats[0].displayName).toBe("New");
    });

    it("returns empty array for unknown participant", () => {
      expect(db.findChatsForParticipant("nobody@s.whatsapp.net")).toHaveLength(0);
    });

    it("deleteChatMembersForJid removes rows by chat_jid and participant_jid", () => {
      db.upsertChatMember({ chatJid: "g1@g.us", participantJid: "p1@s.whatsapp.net", displayName: null, lastVerifiedAt: 1000 });
      db.upsertChatMember({ chatJid: "g2@g.us", participantJid: "p1@s.whatsapp.net", displayName: null, lastVerifiedAt: 1000 });
      db.deleteChatMembersForJid("g1@g.us");
      // g1 members gone; g2 still present
      expect(db.findChatsForParticipant("p1@s.whatsapp.net").map(c => c.chatJid)).toEqual(["g2@g.us"]);
    });
  });

  describe("chats", () => {
    it("upserts and retrieves a chat", () => {
      db.upsertChat({ jid: "447700900123@s.whatsapp.net", displayName: "Alice", isGroup: false, lastActivityAt: 1000 });
      const chat = db.getChat("447700900123@s.whatsapp.net");
      expect(chat).not.toBeNull();
      expect(chat!.displayName).toBe("Alice");
      expect(chat!.isGroup).toBe(false);
    });

    it("lists chats ordered by last activity", () => {
      db.upsertChat({ jid: "a@s.whatsapp.net", isGroup: false, lastActivityAt: 1000 });
      db.upsertChat({ jid: "b@s.whatsapp.net", isGroup: false, lastActivityAt: 2000 });
      const chats = db.listChats();
      expect(chats[0].jid).toBe("b@s.whatsapp.net");
    });
  });

  describe("gaps", () => {
    it("records and retrieves a gap", () => {
      const id = db.recordGap({
        chatJid: "447700900123@s.whatsapp.net",
        fromTs: 1_000_000,
        toTs: 2_000_000,
        reason: "gateway_offline",
        backfillAttempted: false,
        backfillSucceeded: false,
      });
      const gap = db.getGap(id);
      expect(gap).not.toBeNull();
      expect(gap!.reason).toBe("gateway_offline");
      expect(gap!.backfillAttempted).toBe(false);
    });

    it("resolves a gap", () => {
      const id = db.recordGap({ chatJid: null, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: true, backfillSucceeded: false });
      db.resolveGap(id);
      const gap = db.getGap(id);
      expect(gap!.resolvedAt).not.toBeNull();
    });

    it("listGaps returns all gaps", () => {
      db.recordGap({ chatJid: null, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
      db.recordGap({ chatJid: "jid@s.whatsapp.net", fromTs: 3000, toTs: 4000, reason: "reconnect_history_loss", backfillAttempted: true, backfillSucceeded: true });
      expect(db.listGaps()).toHaveLength(2);
    });

    it("listGaps(true) returns only unresolved", () => {
      const id1 = db.recordGap({ chatJid: null, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
      db.recordGap({ chatJid: null, fromTs: 3000, toTs: 4000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
      db.resolveGap(id1);
      expect(db.listGaps(true)).toHaveLength(1);
    });

    it("updateGap sets backfill flags", () => {
      const id = db.recordGap({ chatJid: null, fromTs: 1000, toTs: 2000, reason: "gateway_offline", backfillAttempted: false, backfillSucceeded: false });
      db.updateGap(id, { backfillAttempted: true, backfillSucceeded: true });
      const gap = db.getGap(id);
      expect(gap!.backfillAttempted).toBe(true);
      expect(gap!.backfillSucceeded).toBe(true);
    });
  });
});
