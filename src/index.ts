import express from "express";
import { config } from "./config.js";
import { createApiRouter } from "./routes/api.js";
import type { ConnectionStatus } from "./types.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const startedAt = Date.now();

  let connectionStatus: ConnectionStatus = "disconnected";

  const app = express();
  app.use(express.json());

  const apiRouter = createApiRouter({
    startedAt,
    version: VERSION,
    getConnectionStatus: () => connectionStatus,
  });
  app.use("/api", apiRouter);

  app.get("/", (_req, res) => res.redirect("/api/status"));

  app.listen(config.PORT, config.BIND_ADDRESS, () => {
    console.log(
      `WhatsApp gateway v${VERSION} listening on http://${config.BIND_ADDRESS}:${config.PORT}`
    );
    console.log(`Status: GET /api/status`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} received — shutting down`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
