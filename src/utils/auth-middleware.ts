import type { Request, Response, NextFunction } from "express";

export function createBearerAuthMiddleware(token: string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized", message: "Missing Authorization header" });
      return;
    }
    const provided = authHeader.slice("Bearer ".length);
    if (provided !== token) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token" });
      return;
    }
    next();
  };
}
