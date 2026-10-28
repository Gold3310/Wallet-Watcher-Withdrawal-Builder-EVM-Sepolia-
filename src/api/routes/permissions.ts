import { Request, Response, NextFunction, Router } from "express";
import { config } from "../../config/index.js";
import {
  getSession,
  grantPermissions,
  inspectContext,
  listSessions,
  redeemPermission,
  revokeSession,
} from "../../domain/permissions/permission.service.js";
import { SIGNER_TYPES } from "../../domain/permissions/types.js";
import { actorId } from "../middleware/auth.js";
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
} from "../middleware/idempotency.js";

export const permissionsRouter = Router();

interface GrantBody {
  fromWalletIndex?: number;
  expiry?: number;
  permissions?: unknown;
  signerType?: string;
}

interface RedeemBody {
  toAddress?: string;
  amountWei?: string;
  broadcast?: boolean;
}

/**
 * POST /permissions
 * Builds a `wallet_grantPermissions` grant, registers the session and returns
 * both the RPC request that would be sent to a wallet and the response a
 * wallet returns.
 */
permissionsRouter.post(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as GrantBody;

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

      if (
        body.signerType !== undefined &&
        !SIGNER_TYPES.includes(body.signerType as never)
      ) {
        throw new Error(`signerType must be one of: ${SIGNER_TYPES.join(", ")}`);
      }

      const result = grantPermissions({
        fromWalletIndex: body.fromWalletIndex,
        expiry: body.expiry,
        permissions: body.permissions as never,
        signerType: body.signerType as never,
      });

      res.status(201).json({
        network: config.network,
        chainId: config.chainId,
        method: "wallet_grantPermissions",
        request: result.request,
        response: result.response,
        session: result.session,
      });
    } catch (error) {
      next(error);
    }
  },
);

/** GET /permissions?walletIndex=0 */
permissionsRouter.get(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.query.walletIndex;
      const walletIndex =
        raw === undefined
          ? undefined
          : parseWalletIndex(String(raw));

      res.json({
        network: config.network,
        chainId: config.chainId,
        sessions: listSessions(walletIndex),
      });
    } catch (error) {
      next(error);
    }
  },
);

/** GET /permissions/context/:context — decode a permissionsContext. */
permissionsRouter.get(
  "/context/:context",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        context: inspectContext(String(req.params.context)),
      });
    } catch (error) {
      next(error);
    }
  },
);

/** GET /permissions/:id */
permissionsRouter.get(
  "/:id",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        session: getSession(parseId(String(req.params.id))),
      });
    } catch (error) {
      next(error);
    }
  },
);

/** POST /permissions/:id/revoke */
permissionsRouter.post(
  "/:id/revoke",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        session: revokeSession(parseId(String(req.params.id))),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /permissions/:id/redeem
 * Authorises an action with the session key, checks expiry + policies, then
 * builds (and optionally broadcasts) the withdrawal.
 */
permissionsRouter.post(
  "/:id/redeem",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as RedeemBody;

      if (!body.toAddress) {
        throw new Error("toAddress is required");
      }

      if (!body.amountWei) {
        throw new Error("amountWei is required");
      }

      const sessionId = parseId(String(req.params.id));
      const broadcast = body.broadcast ?? false;
      const actor = actorId(req);

      const idempotency = beginIdempotentRequest(
        req,
        res,
        `permissions:redeem:${sessionId}`,
        { sessionId, toAddress: body.toAddress, amountWei: body.amountWei, broadcast },
        broadcast,
      );

      if (!idempotency) {
        return;
      }

      try {
        const result = await redeemPermission({
          sessionId,
          toAddress: body.toAddress,
          amountWei: body.amountWei,
          broadcast,
          actor,
        });

        const status = result.withdrawal.broadcast ? 201 : 200;

        const response = {
          network: config.network,
          chainId: config.chainId,
          broadcast: result.withdrawal.broadcast,
          txHash: result.withdrawal.txHash ?? null,
          requestedBy: actor,
          authorization: result.authorization,
          transaction: result.withdrawal.built,
          session: result.session,
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

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Session id must be a positive integer");
  }
  return id;
}

function parseWalletIndex(raw: string): number {
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= config.walletCount) {
    throw new Error(
      `walletIndex must be between 0 and ${config.walletCount - 1}`,
    );
  }
  return index;
}
