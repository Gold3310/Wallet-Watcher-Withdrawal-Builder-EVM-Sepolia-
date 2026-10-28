import express, { NextFunction, Request, Response } from "express";
import { authenticate } from "./middleware/auth.js";
import { permissionsRouter } from "./routes/permissions.js";
import { walletsRouter } from "./routes/wallets.js";
import { withdrawalsRouter } from "./routes/withdrawals.js";

export function createApp() {
  const app = express();

  app.use(express.json());

  // /health stays unauthenticated for load balancers.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(authenticate);

  app.use("/permissions", permissionsRouter);
  app.use("/wallets", walletsRouter);
  app.use("/withdrawals", withdrawalsRouter);

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message =
        error instanceof Error ? error.message : "Internal server error";
      const status = message.includes("required") ||
        message.includes("must be") ||
        message.includes("invalid") ||
        message.includes("Insufficient") ||
        message.includes("does not exist") ||
        message.includes("does not grant") ||
        message.includes("expired") ||
        message.includes("revoked") ||
        message.includes("exceeds") ||
        message.includes("allowlist")
        ? 400
        : 500;

      res.status(status).json({ error: message });
    },
  );

  return app;
}
