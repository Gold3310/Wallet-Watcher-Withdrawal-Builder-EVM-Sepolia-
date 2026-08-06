import { Router, Request, Response, NextFunction } from "express";
import {
  createWithdrawal,
  WithdrawalRequest,
} from "../../domain/withdrawal/withdrawal.service.js";
import { config } from "../../config/index.js";

export const withdrawalsRouter = Router();

interface WithdrawalBody {
  fromWalletIndex?: number;
  toAddress?: string;
  amountWei?: string;
  broadcast?: boolean;
}

withdrawalsRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as WithdrawalBody;
      const request = validateWithdrawalRequest(body);
      const result = await createWithdrawal(request);

      res.status(result.broadcast ? 201 : 200).json({
        network: config.network,
        chainId: config.chainId,
        broadcast: result.broadcast,
        txHash: result.txHash ?? null,
        transaction: result.built,
      });
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
