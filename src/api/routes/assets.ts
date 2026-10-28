import { NextFunction, Request, Response, Router } from "express";
import {
  getAllWalletAssets,
  getWalletAssetsByIndex,
  totalsOf,
} from "../../domain/assets/asset.service.js";
import { config } from "../../config/index.js";

export const assetsRouter = Router();

/**
 * GET /assets?walletIndex=N
 *
 * Native and ERC-20 balances read live from the chain. This is a read-only
 * view: it does not touch the persisted balances, which are updated by the
 * poller, and it signs nothing.
 */
assetsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.query.walletIndex;

      if (raw === undefined) {
        const assets = await getAllWalletAssets();
        res.json({
          network: config.network,
          chainId: config.chainId,
          walletCount: assets.length,
          trackedContracts: config.trackedContracts,
          totals: totalsOf(assets),
          wallets: assets,
        });
        return;
      }

      const index = Number(String(raw));
      if (!Number.isInteger(index) || index < 0 || index >= config.walletCount) {
        throw new Error(
          `walletIndex must be between 0 and ${config.walletCount - 1}`,
        );
      }

      const asset = await getWalletAssetsByIndex(index);
      res.json({
        network: config.network,
        chainId: config.chainId,
        trackedContracts: config.trackedContracts,
        wallet: asset,
      });
    } catch (error) {
      next(error);
    }
  },
);
