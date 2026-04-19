#!/usr/bin/env node
import * as fs from "node:fs";

export interface CliOptions {
  baseUrl?: string;
  token?: string;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function runCli(opts: CliOptions): Promise<number> {
  const baseUrl = opts.baseUrl ?? process.env.WA_GATEWAY_URL ?? "http://localhost:3100";
  const token = opts.token ?? process.env.WA_GATEWAY_TOKEN ?? null;
  const out = opts.stdout ?? ((s) => console.log(s));
  const err = opts.stderr ?? ((s) => console.error(s));

  async function apiFetch(path: string, fetchOpts: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { ...fetchOpts, headers: { ...headers, ...(fetchOpts.headers as Record<string, string> ?? {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }

  function print(data: unknown): void {
    out(JSON.stringify(data, null, 2));
  }

  const args = opts.args;
  const cmd = args[0];
  const sub = args[1];

  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
  }

  try {
    if (cmd === "status") {
      print(await apiFetch("/api/status"));
    } else if (cmd === "auth") {
      if (sub === "status") {
        print(await apiFetch("/api/auth/status"));
      } else if (sub === "qr") {
        print(await apiFetch("/api/auth/qr"));
      } else if (sub === "wipe") {
        print(await apiFetch("/api/auth", { method: "DELETE" }));
      } else {
        err("Usage: wa auth <status|qr|wipe>");
        return 1;
      }
    } else if (cmd === "chats") {
      if (sub === "list") {
        print(await apiFetch("/api/chats"));
      } else {
        err("Usage: wa chats list [--unread]");
        return 1;
      }
    } else if (cmd === "read") {
      if (!sub) { err("Usage: wa read <jid> [--full] [--from <iso>] [--to <iso>]"); return 1; }
      const params = new URLSearchParams();
      if (hasFlag("full")) {
        params.set("mode", "full");
      } else {
        const from = flag("from");
        const to = flag("to");
        if (from) params.set("from", from);
        if (to) params.set("to", to);
      }
      print(await apiFetch(`/api/chats/${encodeURIComponent(sub)}/messages?${params}`));
    } else if (cmd === "ack") {
      const watermark = flag("watermark");
      if (!sub || !watermark) { err("Usage: wa ack <jid> --watermark <iso>"); return 1; }
      print(await apiFetch(`/api/chats/${encodeURIComponent(sub)}/ack`, { method: "POST", body: JSON.stringify({ watermark }) }));
    } else if (cmd === "contacts") {
      if (sub === "chats") {
        const identifier = args[2];
        if (!identifier) { err("Usage: wa contacts chats <identifier>"); return 1; }
        print(await apiFetch(`/api/contacts/${encodeURIComponent(identifier)}/chats`));
      } else if (sub === "refresh") {
        print(await apiFetch("/api/contacts/refresh", { method: "POST" }));
      } else {
        err("Usage: wa contacts <chats <identifier>|refresh>"); return 1;
      }
    } else if (cmd === "no-read") {
      if (sub === "list") {
        print(await apiFetch("/api/no-read"));
      } else if (sub === "add") {
        const identifier = args[2];
        if (!identifier) { err("Usage: wa no-read add <identifier>"); return 1; }
        print(await apiFetch("/api/no-read", { method: "POST", body: JSON.stringify({ identifier }) }));
      } else if (sub === "remove") {
        const jid = args[2];
        if (!jid) { err("Usage: wa no-read remove <jid>"); return 1; }
        print(await apiFetch(`/api/no-read/${encodeURIComponent(jid)}`, { method: "DELETE" }));
      } else {
        err("Usage: wa no-read <list|add|remove>"); return 1;
      }
    } else if (cmd === "send") {
      const to = flag("to");
      const text = flag("text");
      const file = flag("file");
      if (file) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
        print(await apiFetch("/api/send", { method: "POST", body: JSON.stringify(data) }));
      } else if (to && text) {
        print(await apiFetch("/api/send", { method: "POST", body: JSON.stringify({ messages: [{ to, text }] }) }));
      } else {
        err("Usage: wa send --to <e164> --text <msg>  OR  wa send --file <json>"); return 1;
      }
    } else if (cmd === "gaps") {
      if (sub === "list") {
        print(await apiFetch("/api/gaps"));
      } else {
        err("Usage: wa gaps list"); return 1;
      }
    } else if (cmd === "import-export") {
      const file = sub;
      const jid = flag("jid");
      if (!file || !jid) { err("Usage: wa import-export <file> --jid <jid>"); return 1; }
      const fileBuffer = fs.readFileSync(file);
      const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chat.txt"\r\nContent-Type: text/plain\r\n\r\n`),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const hdrs: Record<string, string> = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
      if (token) hdrs["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${baseUrl}/api/import/phone-export?jid=${encodeURIComponent(jid)}`, { method: "POST", body, headers: hdrs });
      print(await res.json());
    } else {
      err([
        "Usage: wa <command>",
        "",
        "Commands:",
        "  status",
        "  auth status|qr|wipe",
        "  chats list [--unread]",
        "  read <jid> [--full] [--from <iso>] [--to <iso>]",
        "  ack <jid> --watermark <iso>",
        "  contacts chats <identifier>",
        "  contacts refresh",
        "  no-read list|add|remove",
        "  send --to <e164> --text <msg>",
        "  send --file <json>",
        "  gaps list",
        "  import-export <file> --jid <jid>",
      ].join("\n"));
      return 1;
    }

    return 0;
  } catch (e) {
    err(`Error: ${(e as Error).message}`);
    return 1;
  }
}

// Entry point when run directly
if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  runCli({ args: process.argv.slice(2) }).then((code) => process.exit(code));
}
