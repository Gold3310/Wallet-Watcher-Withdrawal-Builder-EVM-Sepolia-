import { NextFunction, Request, Response, Router } from "express";
import { config } from "../../config/index.js";
import {
  getAllWalletAssets,
  getHolderReports,
  getOwnershipAnalyses,
  getTrackedContractInfo,
  getWalletAssetsByIndex,
  totalsOf,
} from "../../domain/assets/asset.service.js";
import {
  buildWithdrawalCatalog,
  findWithdrawalCapability,
} from "../../domain/assets/withdrawals.catalog.js";
import {
  createUnwrap,
  UnwrapRequest,
} from "../../domain/assets/unwrap.service.js";
import { getHolderActivity } from "../../infra/db/database.js";
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

/**
 * GET /assets/holders
 *
 * Answers the question that decides whether anything is reachable at all:
 * who holds the tracked token.
 *
 * For a WETH-style token the answer is everything, because `withdraw()` is
 * ungated and burns a balance to release ETH 1:1. Whoever holds the token can
 * take the ETH; nobody else can, whatever role they hold.
 *
 * The report deliberately includes the contract's own balance in itself, since
 * the belief that a contract holds the balances recorded in its `balanceOf`
 * mapping is the one that makes this look solvable when it is not. That belief
 * is settled here by reading `balanceOf(<the contract>)` rather than by
 * arguing about it.
 */
assetsRouter.get(
  "/holders",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        trackedContracts: config.trackedContracts,
        reports: await getHolderReports(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /assets/holder-activity
 *
 * Everything the watcher has seen, newest first: which holder moved, whether
 * they redeemed or transferred, whether the ETH reserve shifted, and whether
 * the token ever reached an address this service can sign for.
 *
 * Unchanged polls are not recorded, so this reads as a list of things that
 * happened rather than a log of nothing happening.
 */
assetsRouter.get(
  "/holder-activity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = Number(String(req.query.limit ?? "100"));
      const limit =
        Number.isInteger(raw) && raw > 0 && raw <= 1000 ? raw : 100;

      res.json({
        network: config.network,
        chainId: config.chainId,
        activity: getHolderActivity(limit).map((row) => ({
          observedAt: new Date(row.observed_at * 1000).toISOString(),
          contract: row.contract,
          address: row.address,
          label: row.label,
          change: row.change_type,
          detail: row.detail,
          balanceRaw: row.balance_raw,
          ethReserveRaw: row.eth_reserve_raw,
          signableByService: row.signable === 1,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /assets/ownership
 *
 * Can the owner role be moved to you, and would holding it do anything?
 *
 * Two questions kept apart on purpose, because they fail for unrelated
 * reasons: moving the role needs the current owner's signature, and the role's
 * worth is a property of the ABI. On the tracked contract the answer to the
 * first is no and the second is nothing — the owner may call setProposer,
 * transferOwnership and renounceOwnership, and cannot touch a single wei.
 *
 * Computed from the ABI each run rather than asserted, so it stays correct if
 * the contract ever changes.
 */
assetsRouter.get(
  "/ownership",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        analyses: await getOwnershipAnalyses(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /assets/withdrawals
 *
 * Every way value can move out of this system, in one response: the contract's
 * own functions, this service's routes, and the CLI — each with what it needs,
 * whether it can run here, and precisely why not when it cannot.
 *
 * Built from the ABI, so it cannot drift from the deployed contract. Anything
 * in the ABI that is not classified is still listed as `unclassified`, because
 * showing you something unexpected is better than hiding it.
 *
 * GET /assets/withdrawals/:id returns a single capability.
 */
assetsRouter.get(
  "/withdrawals",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(buildWithdrawalCatalog());
    } catch (error) {
      next(error);
    }
  },
);

assetsRouter.get(
  "/withdrawals/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const capability = findWithdrawalCapability(id);
      if (capability === undefined) {
        res
          .status(404)
          .json({ error: `No withdrawal capability with id "${id}"` });
        return;
      }
      res.json(capability);
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
