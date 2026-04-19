import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import express from "express";
import { runCli } from "../src/cli.js";

function startMockServer(handlers: Record<string, (req: express.Request, res: express.Response) => void>) {
  const app = express();
  app.use(express.json());

  for (const [route, handler] of Object.entries(handlers)) {
    const [method, path] = route.split(" ");
    (app as any)[method.toLowerCase()](path, handler);
  }

  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

async function cli(args: string[], port: number): Promise<{ output: string; exitCode: number }> {
  const lines: string[] = [];
  const exitCode = await runCli({
    args,
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: (s) => lines.push(s),
    stderr: (s) => lines.push(s),
  });
  return { output: lines.join("\n"), exitCode };
}

describe("Phase 10: CLI", () => {
  let server: http.Server;

  afterEach(() => {
    if (server) server.close();
  });

  it("wa status outputs daemon status JSON", async () => {
    const expected = { status: "ok", connection: "connected", version: "1.0.0" };
    ({ server } = await startMockServer({ "GET /api/status": (_req, res) => res.json(expected) }));
    const addr = server.address() as { port: number };
    const { output, exitCode } = await cli(["status"], addr.port);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject(expected);
  });

  it("wa auth status outputs auth status JSON", async () => {
    ({ server } = await startMockServer({ "GET /api/auth/status": (_req, res) => res.json({ status: "connected" }) }));
    const { port } = server.address() as { port: number };
    const { output } = await cli(["auth", "status"], port);
    expect(JSON.parse(output)).toMatchObject({ status: "connected" });
  });

  it("wa chats list outputs chats", async () => {
    const chats = [{ jid: "447700900123@s.whatsapp.net" }];
    ({ server } = await startMockServer({ "GET /api/chats": (_req, res) => res.json({ chats }) }));
    const { port } = server.address() as { port: number };
    const { output } = await cli(["chats", "list"], port);
    expect(JSON.parse(output)).toMatchObject({ chats });
  });

  it("wa no-read list outputs entries", async () => {
    ({ server } = await startMockServer({ "GET /api/no-read": (_req, res) => res.json({ entries: [] }) }));
    const { port } = server.address() as { port: number };
    const { output } = await cli(["no-read", "list"], port);
    expect(JSON.parse(output)).toMatchObject({ entries: [] });
  });

  it("wa no-read add posts identifier and returns jid", async () => {
    let receivedBody: unknown;
    ({ server } = await startMockServer({
      "POST /api/no-read": (req, res) => { receivedBody = req.body; res.status(201).json({ jid: "447700900123@s.whatsapp.net" }); },
    }));
    const { port } = server.address() as { port: number };
    const { output, exitCode } = await cli(["no-read", "add", "+447700900123"], port);
    expect(exitCode).toBe(0);
    expect(receivedBody).toMatchObject({ identifier: "+447700900123" });
    expect(JSON.parse(output)).toMatchObject({ jid: "447700900123@s.whatsapp.net" });
  });

  it("wa send posts to /api/send", async () => {
    let receivedBody: unknown;
    ({ server } = await startMockServer({
      "POST /api/send": (req, res) => { receivedBody = req.body; res.json({ results: [{ to: "+447700900123", status: "sent", messageId: "ID1" }] }); },
    }));
    const { port } = server.address() as { port: number };
    const { output, exitCode } = await cli(["send", "--to", "+447700900123", "--text", "Hello"], port);
    expect(exitCode).toBe(0);
    expect(receivedBody).toMatchObject({ messages: [{ to: "+447700900123", text: "Hello" }] });
    expect(JSON.parse(output).results[0].status).toBe("sent");
  });

  it("wa gaps list outputs gaps", async () => {
    ({ server } = await startMockServer({ "GET /api/gaps": (_req, res) => res.json({ gaps: [] }) }));
    const { port } = server.address() as { port: number };
    const { output } = await cli(["gaps", "list"], port);
    expect(JSON.parse(output)).toMatchObject({ gaps: [] });
  });

  it("wa ack posts watermark", async () => {
    let receivedBody: unknown;
    const jid = "447700900123@s.whatsapp.net";
    const encodedJid = encodeURIComponent(jid);
    ({ server } = await startMockServer({
      [`POST /api/chats/${encodedJid}/ack`]: (req, res) => { receivedBody = req.body; res.json({ ok: true }); },
    }));
    const { port } = server.address() as { port: number };
    const wm = "2026-04-19T12:00:00.000Z";
    await cli(["ack", jid, "--watermark", wm], port);
    expect(receivedBody).toMatchObject({ watermark: wm });
  });

  it("wa contacts refresh calls POST /api/contacts/refresh", async () => {
    ({ server } = await startMockServer({ "POST /api/contacts/refresh": (_req, res) => res.json({ groupsRefreshed: 0, membersUpdated: 0 }) }));
    const { port } = server.address() as { port: number };
    const { output, exitCode } = await cli(["contacts", "refresh"], port);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ groupsRefreshed: 0 });
  });

  it("unknown command returns exit code 1", async () => {
    ({ server } = await startMockServer({}));
    const { port } = server.address() as { port: number };
    const { exitCode } = await cli(["unknowncmd"], port);
    expect(exitCode).toBe(1);
  });
});
