import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHealth, toIdentity } from "../src/services/session-health.js";

const JED_LID = "81995354882069@lid";
const JED_ID = "81995354882069";

describe("toIdentity", () => {
  it("strips the lid suffix", () => {
    expect(toIdentity(JED_LID)).toBe(JED_ID);
  });
  it("strips the phone-jid suffix", () => {
    expect(toIdentity("447753223290@s.whatsapp.net")).toBe("447753223290");
  });
  it("drops the device suffix", () => {
    expect(toIdentity("447753223290:51@s.whatsapp.net")).toBe("447753223290");
  });
});

describe("SessionHealth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sess-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seedSessions = () => {
    writeFileSync(join(dir, `session-${JED_ID}.0.json`), "{}");
    writeFileSync(join(dir, `session-${JED_ID}.51.json`), "{}");
    writeFileSync(join(dir, "session-999.0.json"), "{}");
  };

  it("does not flag a session below the failure threshold", () => {
    const sh = new SessionHealth(dir, { autoHeal: false });
    sh.recordFailure(JED_LID);
    sh.recordFailure(JED_LID);
    expect(sh.broken()).toHaveLength(0);
  });

  it("flags a session once failures reach the threshold", () => {
    const broken: string[] = [];
    const sh = new SessionHealth(dir, { autoHeal: false, onBroken: (e) => broken.push(e.identity) });
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    expect(broken).toEqual([JED_ID]);
    expect(sh.broken()[0]?.failures).toBe(3);
  });

  it("attributes group failures to the participant, not the group", () => {
    const sh = new SessionHealth(dir, { autoHeal: false });
    for (let i = 0; i < 3; i++) sh.recordFailure("123-456@g.us", JED_LID);
    expect(sh.broken()[0]?.identity).toBe(JED_ID);
  });

  it("stops tracking an identity once it decrypts again", () => {
    const sh = new SessionHealth(dir, { autoHeal: false });
    sh.recordFailure(JED_LID);
    sh.recordSuccess(JED_LID);
    expect(sh.report()).toHaveLength(0);
  });

  it("deletes every device session for the identity, leaving others alone", () => {
    seedSessions();
    const sh = new SessionHealth(dir, { autoHeal: false });
    expect(sh.heal(JED_ID)).toBe(2);
    expect(existsSync(join(dir, `session-${JED_ID}.0.json`))).toBe(false);
    expect(existsSync(join(dir, `session-${JED_ID}.51.json`))).toBe(false);
    expect(existsSync(join(dir, "session-999.0.json"))).toBe(true);
  });

  it("heals automatically when the threshold is crossed", () => {
    seedSessions();
    const sh = new SessionHealth(dir);
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    expect(readdirSync(dir).filter((f) => f.startsWith(`session-${JED_ID}.`))).toHaveLength(0);
  });

  it("does not heal again inside the cooldown", () => {
    seedSessions();
    let now = 1_000_000;
    const sh = new SessionHealth(dir, { now: () => now });
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    writeFileSync(join(dir, `session-${JED_ID}.0.json`), "{}");

    now += 60_000; // one minute later — still inside the 6h cooldown
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    expect(existsSync(join(dir, `session-${JED_ID}.0.json`))).toBe(true);
  });

  it("heals again once the cooldown has elapsed", () => {
    seedSessions();
    let now = 1_000_000;
    const sh = new SessionHealth(dir, { now: () => now });
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    writeFileSync(join(dir, `session-${JED_ID}.0.json`), "{}");

    now += 7 * 60 * 60 * 1000; // past the 6h cooldown
    for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
    expect(existsSync(join(dir, `session-${JED_ID}.0.json`))).toBe(false);
  });

  it("gives up after the maximum heal attempts", () => {
    let now = 1_000_000;
    const sh = new SessionHealth(dir, { now: () => now });
    for (let attempt = 0; attempt < 5; attempt++) {
      for (let i = 0; i < 3; i++) sh.recordFailure(JED_LID);
      now += 7 * 60 * 60 * 1000;
    }
    expect(sh.report()[0]?.healAttempts).toBeLessThanOrEqual(3);
  });

  it("survives a missing auth directory", () => {
    const sh = new SessionHealth(join(dir, "nope"), { autoHeal: false });
    expect(sh.heal(JED_ID)).toBe(0);
  });
});
