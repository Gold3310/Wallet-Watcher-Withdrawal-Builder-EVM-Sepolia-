import { Router, Request, Response, NextFunction } from "express";
import { getWalletViews } from "../../domain/balance/balance.service.js";
import { config } from "../../config/index.js";

export const walletsRouter = Router();

walletsRouter.get("/", (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      network: config.network,
      chainId: config.chainId,
      walletCount: config.walletCount,
      wallets: getWalletViews(),
    });
  } catch (error) {
    next(error);
  }
});
