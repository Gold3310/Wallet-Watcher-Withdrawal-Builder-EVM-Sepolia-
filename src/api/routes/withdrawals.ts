import { Router, Request, Response, NextFunction } from "express";
import { config } from "../../config/index.js";
import { createSweep, SweepRequest } from "../../domain/sweep/sweep.service.js";
import {
  createWithdrawal,
  WithdrawalRequest,
} from "../../domain/withdrawal/withdrawal.service.js";
import { BadRequestError } from "../../util/errors.js";
import { actorId } from "../middleware/auth.js";
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
} from "../middleware/idempotency.js";

export const withdrawalsRouter = Router();

interface WithdrawalBody {
  fromWalletIndex?: number;
  toAddress?: string;
  amountWei?: string;
  broadcast?: boolean;
}

interface SweepBody {
  toAddress?: string;
  walletIndices?: unknown;
  tokens?: unknown;
  unwrap?: unknown;
  unwrapContracts?: unknown;
  includeNative?: unknown;
  broadcast?: unknown;
}

withdrawalsRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as WithdrawalBody;
      const request = validateWithdrawalRequest(body);
      request.actor = actorId(req);

      const idempotency = beginIdempotentRequest(
        req,
        res,
        "withdrawals:create",
        request,
        request.broadcast,
      );

      if (!idempotency) {
        return;
      }

      try {
        const result = await createWithdrawal(request);
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

function validateWithdrawalRequest(body: WithdrawalBody): WithdrawalRequest {
  if (body.fromWalletIndex === undefined) {
    throw new Error("fromWalletIndex is required");
  }

  if (!Number.isInteger(body.fromWalletIndex)) {
    throw new Error("fromWalletIndex must be an integer");
  }

  if (
    body.fromWalletIndex < 0 ||
    body.fromWalletIndex >= config.walletCount
  ) {
    throw new Error(
      `fromWalletIndex must be between 0 and ${config.walletCount - 1}`,
    );
  }

  if (!body.toAddress) {
    throw new Error("toAddress is required");
  }

  if (!body.amountWei) {
    throw new Error("amountWei is required");
  }

  return {
    fromWalletIndex: body.fromWalletIndex,
    toAddress: body.toAddress,
    amountWei: body.amountWei,
    broadcast: body.broadcast ?? false,
  };
}

withdrawalsRouter.post(
  "/sweep",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as SweepBody;
      const request = validateSweepRequest(body);
      request.actor = actorId(req);

      const idempotency = beginIdempotentRequest(
        req,
        res,
        "withdrawals:sweep",
        request,
        request.broadcast,
      );

      if (!idempotency) {
        return;
      }

      try {
        const report = await createSweep(request);
        const status =
          report.broadcast && report.summary.stepsBroadcast > 0 ? 201 : 200;

        completeIdempotentRequest(idempotency, status, report);
        res.status(status).json(report);
      } catch (error) {
        abandonIdempotentRequest(idempotency);
        next(error);
      }
    } catch (error) {
      next(error);
    }
  },
);

function assertStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BadRequestError(`${field} must be an array of address strings`);
  }
  return value as string[];
}

function assertBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new BadRequestError(`${field} must be a boolean`);
  }
  return value;
}

function validateSweepRequest(body: SweepBody): SweepRequest {
  if (typeof body.toAddress !== "string" || !body.toAddress.trim()) {
    throw new BadRequestError("toAddress is required");
  }

  let walletIndices: number[] | undefined;
  if (body.walletIndices !== undefined) {
    if (
      !Array.isArray(body.walletIndices) ||
      body.walletIndices.some((entry) => typeof entry !== "number")
    ) {
      throw new BadRequestError(
        "walletIndices must be an array of integer wallet indices",
      );
    }
    walletIndices = body.walletIndices as number[];
  }

  const tokens = assertStringArray(body.tokens, "tokens");
  const unwrapContracts = assertStringArray(
    body.unwrapContracts,
    "unwrapContracts",
  );
  const unwrap = assertBoolean(body.unwrap, "unwrap", false);
  const includeNative = assertBoolean(
    body.includeNative,
    "includeNative",
    true,
  );
  const broadcast = assertBoolean(body.broadcast, "broadcast", false);

  return {
    toAddress: body.toAddress.trim(),
    ...(walletIndices !== undefined ? { walletIndices } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    unwrap,
    ...(unwrapContracts !== undefined ? { unwrapContracts } : {}),
    includeNative,
    broadcast,
  };
}
