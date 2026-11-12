/**
 * The standard-v1 snapshot endpoint.
 *
 * `POST /withdrawals/snapshot` takes a `standard-v1` Merkle tree dump, works out
 * what each vault is owed, and — only when asked — signs and broadcasts the
 * transfers. It sits under `/withdrawals` so it is behind the same bearer auth,
 * the same sole-owner gate and the same idempotency handling as a single
 * withdrawal. A snapshot moves every vault at once, so it is the request that
 * most needs those guards, not the one that can do without them.
 *
 * `broadcast` defaults to false and the response then contains the full plan
 * without a single signature. That is the intended way to inspect a snapshot
 * before trusting it.
 */
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../../config/index.js";
import {
  processStandardV1Snapshot,
  SnapshotRun,
  StandardV1Snapshot,
} from "../../domain/withdrawal/merkle.integration.js";
import { BadRequestError } from "../../util/errors.js";
import { actorId } from "../middleware/auth.js";
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
} from "../middleware/idempotency.js";

export const snapshotRouter = Router();

interface SnapshotBody {
  snapshot?: StandardV1Snapshot;
  broadcast?: boolean;
  /** Rehearse everything but sign nothing. Implied by `broadcast: false`. */
  execute?: boolean;
}

snapshotRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as SnapshotBody;

    try {
      if (!body || typeof body !== "object" || !body.snapshot) {
        throw new BadRequestError(
          "snapshot is required: send the standard-v1 tree as {\"snapshot\": {...}}",
        );
      }

      const broadcast = body.broadcast ?? false;
      const execute = (body.execute ?? false) || broadcast;

      const idempotency = beginIdempotentRequest(
        req,
        res,
        "withdrawals:snapshot",
        body,
        broadcast,
      );

      if (!idempotency) {
        return;
      }

      try {
        let run: SnapshotRun;
        try {
          run = await processStandardV1Snapshot(body.snapshot, {
            execute,
            broadcast,
            actor: actorId(req),
          });
        } catch (error) {
          // A snapshot that does not parse is the caller's mistake, not a
          // server fault. Everything the plan does is validation and pure
          // arithmetic, so a throw here is always about the payload.
          throw new BadRequestError(
            error instanceof Error ? error.message : String(error),
          );
        }

        const status = broadcast ? 201 : 200;
        const response = toResponse(run);

        completeIdempotentRequest(idempotency, status, response);
        res.status(status).json(response);
      } catch (error) {
        abandonIdempotentRequest(idempotency);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  },
);

function toResponse(run: SnapshotRun) {
  const failures = run.results.filter((result) => result.status === "failed");

  return {
    network: run.network,
    chainId: run.chainId,
    refSlot: run.refSlot,
    block: run.block,
    executed: run.executed,
    broadcast:
      run.executed && run.results.some((result) => result.status === "broadcast"),
    totals: { netWei: run.totalNetWei, netEth: run.totalNetEth },
    entries: run.entries.map((entry) => ({
      address: entry.address,
      treeIndex: entry.treeIndex,
      fromWalletIndex: entry.fromWalletIndex,
      amountWei: entry.netAmountWei,
      deductions: {
        totalValueWei: entry.totalValueWei,
        feeWei: entry.feeWei,
        liabilitySharesWei: entry.liabilitySharesWei,
        maxLiabilitySharesWei: entry.maxLiabilitySharesWei,
        slashingReserveWei: entry.slashingReserveWei,
        infraFeeWei: entry.infraFeeWei,
        liquidityFeeWei: entry.liquidityFeeWei,
        reservationFeeWei: entry.reservationFeeWei,
      },
    })),
    skipped: run.skipped.map((leaf) => ({
      address: leaf.address,
      netAmountWei: leaf.netAmountWei,
      reason: leaf.reason,
      detail: leaf.detail,
    })),
    evidence: run.evidence,
    results: run.results.map((result) =>
      result.status === "failed"
        ? { address: result.address, status: result.status, error: result.error }
        : {
            address: result.address,
            status: result.status,
            txHash: result.result.txHash ?? null,
            transaction: result.result.built,
          },
    ),
    ...(failures.length > 0 ? { failedCount: failures.length } : {}),
  };
}
