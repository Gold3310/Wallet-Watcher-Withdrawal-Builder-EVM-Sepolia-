import express, { NextFunction, Request, Response } from "express";
import path from "node:path";
import { authenticate, authorizeOwner } from "./middleware/auth.js";
import { BadRequestError } from "../util/errors.js";
import { config } from "../config/index.js";
import {
  buildBalanceOfCalldata,
  buildWithdrawCalldata,
} from "../domain/assets/withdraw.calldata.js";
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

  /**
   * The withdraw page, mounted BEFORE authentication.
   *
   * A browser needs to load the page and ask for calldata, and neither
   * reveals anything nor changes anything: the page is static, and the
   * encoding is arithmetic on a number. Requiring an API token here would
   * only push the user into pasting a secret into a web page.
   *
   * Nothing in this group signs, broadcasts, or reads funds. The signature
   * comes from the visitor's own wallet, in their browser, and never reaches
   * this server.
   */
  app.get("/withdraw", (_req, res, next) => {
    res.sendFile(
      path.join(process.cwd(), "public", "withdraw.html"),
      (error) => {
        if (error) {
          next(error);
        }
      },
    );
  });

  app.get("/withdraw/config", (_req, res) => {
    res.json({
      contract: config.trackedContracts[0],
      chainId: config.chainId,
      symbol: "ABT",
      decimals: 18,
      network: config.network,
    });
  });

  app.post("/withdraw/calldata", (req, res, next) => {
    try {
      const body = req.body as {
        action?: string;
        amountWei?: string;
        address?: string;
      };

      const contract = config.trackedContracts[0];

      if (body.action === "withdraw") {
        if (body.amountWei === undefined) {
          throw new BadRequestError("amountWei is required");
        }
        res.json({
          to: contract,
          data: buildWithdrawCalldata(body.amountWei),
          value: "0",
          chainId: config.chainId,
        });
        return;
      }

      if (body.action === "balanceOf") {
        if (body.address === undefined) {
          throw new BadRequestError("address is required");
        }
        res.json({
          to: contract,
          data: buildBalanceOfCalldata(body.address),
        });
        return;
      }

      throw new BadRequestError("action must be `withdraw` or `balanceOf`");
    } catch (error) {
      next(error);
    }
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
