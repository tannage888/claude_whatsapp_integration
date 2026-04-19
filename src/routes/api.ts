import { Router } from "express";
import type { ConnectionStatus, DaemonStatus } from "../types.js";

interface RouterDeps {
  startedAt: number;
  getConnectionStatus: () => ConnectionStatus;
  version: string;
}

export function createApiRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const body: DaemonStatus = {
      status: "ok",
      connection: deps.getConnectionStatus(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      startedAt: new Date(deps.startedAt).toISOString(),
      version: deps.version,
    };
    res.json(body);
  });

  return router;
}
