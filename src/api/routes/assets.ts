import { NextFunction, Request, Response, Router } from "express";
import { config } from "../../config/index.js";
import {
  getAllWalletAssets,
  getTrackedContractInfo,
  getWalletAssetsByIndex,
  totalsOf,
} from "../../domain/assets/asset.service.js";
import {
  createUnwrap,
  UnwrapRequest,
} from "../../domain/assets/unwrap.service.js";
import { actorId } from "../middleware/auth.js";
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
} from "../middleware/idempotency.js";

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
          contracts: await getTrackedContractInfo(),
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
        contracts: await getTrackedContractInfo(),
        wallet: asset,
      });
    } catch (error) {
      next(error);
    }
  },
);

interface UnwrapBody {
  fromWalletIndex?: number;
  amountWei?: string;
  broadcast?: boolean;
}

/**
 * POST /assets/unwrap
 *
 * Turns a tracked WETH-style balance back into ETH in the same wallet, because
 * the tracked contract's transfer() is gated and an ordinary withdrawal would
 * revert with "Transfer not permitted".
 *
 * The ETH lands in the wallet that held the balance. Move it on with
 * POST /withdrawals. Nothing is broadcast unless `broadcast` is true.
 */
assetsRouter.post(
  "/unwrap",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = validateUnwrapRequest(req.body as UnwrapBody);
      request.actor = actorId(req);

      const idempotency = beginIdempotentRequest(
        req,
        res,
        "assets:unwrap",
        request,
        request.broadcast,
      );

      if (!idempotency) {
        return;
      }

      try {
        const result = await createUnwrap(request);
        const status = result.broadcast ? 201 : 200;

        const response = {
          network: config.network,
          chainId: config.chainId,
          broadcast: result.broadcast,
          txHash: result.txHash ?? null,
          requestedBy: request.actor,
          transaction: result.built,
        };

        completeIdempotentRequest(idempotency, status, response);
        res.status(status).json(response);
      } catch (error) {
        abandonIdempotentRequest(idempotency);
        next(error);
      }
    } catch (error) {
      next(error);
    }
  },
);

function validateUnwrapRequest(body: UnwrapBody): UnwrapRequest {
  if (body.fromWalletIndex === undefined) {
    throw new Error("fromWalletIndex is required");
  }

  if (!Number.isInteger(body.fromWalletIndex)) {
    throw new Error("fromWalletIndex must be an integer");
  }

  if (body.fromWalletIndex < 0 || body.fromWalletIndex >= config.walletCount) {
    throw new Error(
      `fromWalletIndex must be between 0 and ${config.walletCount - 1}`,
    );
  }

  if (!body.amountWei) {
    throw new Error("amountWei is required");
  }

  return {
    fromWalletIndex: body.fromWalletIndex,
    amountWei: body.amountWei,
    broadcast: body.broadcast ?? false,
  };
}
