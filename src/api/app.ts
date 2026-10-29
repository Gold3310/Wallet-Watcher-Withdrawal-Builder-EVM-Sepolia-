import express, { NextFunction, Request, Response } from "express";
import { authenticate, authorizeOwner } from "./middleware/auth.js";
import { BadRequestError } from "../util/errors.js";
import { assetsRouter } from "./routes/assets.js";
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
  // Second gate: when OWNER_ADDRESS is set, nothing but that owner gets through.
  app.use(authorizeOwner);

  app.use("/assets", assetsRouter);
  app.use("/permissions", permissionsRouter);
  app.use("/wallets", walletsRouter);
  app.use("/withdrawals", withdrawalsRouter);

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message =
        error instanceof Error ? error.message : "Internal server error";

      // Typed validation failures are 400 by construction. The substring check
      // below is a fallback for routes that still throw plain Errors.
      if (error instanceof BadRequestError) {
        res.status(400).json({ error: message });
        return;
      }

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
