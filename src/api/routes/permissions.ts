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
import {
  getSupportedExecutionPermissions,
  toPermissionResponse,
  translateRequest,
  type PermissionRequest,
} from "../../domain/permissions/erc7715.js";
import {
  buildRedeemDelegation,
  type Execution,
} from "../../domain/permissions/redeem7715.js";
import { nowSeconds } from "../../domain/permissions/permission.service.js";
import { BadRequestError } from "../../util/errors.js";
import { getWalletByIndex } from "../../infra/db/database.js";
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
        throw new BadRequestError("fromWalletIndex is required");
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
/**
 * GET /permissions/supported
 *
 * `wallet_getSupportedExecutionPermissions`: what this wallet will grant.
 * Only types and rules the enforcement path actually checks are advertised —
 * listing a rule nothing enforces would let a requester believe in a
 * restriction that does not exist.
 */
permissionsRouter.get(
  "/supported",
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        network: config.network,
        chainId: config.chainId,
        method: "wallet_getSupportedExecutionPermissions",
        result: getSupportedExecutionPermissions(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /permissions/request
 *
 * `wallet_requestExecutionPermissions` in its current spec shape: `chainId`,
 * `to`, a permission carrying `isAdjustmentAllowed`, and `rules` rather than
 * policies. Translated onto the same grant engine the Openfort-shaped
 * `POST /permissions` uses, so there is one enforcement path, not two.
 */
permissionsRouter.post(
  "/request",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        fromWalletIndex?: number;
        request?: PermissionRequest;
      };

      if (body.fromWalletIndex === undefined) {
        throw new Error("fromWalletIndex is required");
      }

      if (
        !Number.isInteger(body.fromWalletIndex) ||
        body.fromWalletIndex < 0 ||
        body.fromWalletIndex >= config.walletCount
      ) {
        throw new BadRequestError(
          `fromWalletIndex must be an integer between 0 and ${config.walletCount - 1}`,
        );
      }

      const request = body.request;

      if (request === undefined || request === null) {
        throw new BadRequestError("request is required and must be a PermissionRequest");
      }

      const translated = translateRequest(request, nowSeconds());

      // If the request names the granting account, it has to be the wallet it
      // is being granted from. Anything else is a mismatch worth refusing
      // rather than quietly overriding.
      const wallet = getWalletByIndex(body.fromWalletIndex);
      if (!wallet) {
        throw new BadRequestError(`Wallet index ${body.fromWalletIndex} does not exist`);
      }

      if (
        translated.from !== null &&
        translated.from.toLowerCase() !== wallet.address.toLowerCase()
      ) {
        throw new BadRequestError(
          `request.from ${translated.from} is not wallet ${body.fromWalletIndex} ` +
            `(${wallet.address}). Granting it anyway would return a permission ` +
            `naming an account that never consented.`,
        );
      }

      const result = grantPermissions({
        fromWalletIndex: body.fromWalletIndex,
        expiry: translated.expiry,
        permissions: translated.permissions,
        signerType: translated.signerType,
      });

      res.status(201).json({
        network: config.network,
        chainId: config.chainId,
        method: "wallet_requestExecutionPermissions",
        // Echoed as granted: this wallet does not attenuate, so what was
        // asked for is what was granted.
        request,
        response: toPermissionResponse(request, result.session),
        session: result.session,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /permissions/redeem-delegation
 *
 * Builds the `redeemDelegation` call that spends a granted permission through
 * the ERC-7710 delegation manager. Returns calldata only — nothing is sent.
 */
permissionsRouter.post(
  "/redeem-delegation",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        contexts?: string[];
        executions?: Execution[];
        method?: "redeemDelegation" | "redeemDelegations";
        delegationManager?: string;
      };

      if (!Array.isArray(body.contexts) || body.contexts.length === 0) {
        throw new BadRequestError("contexts must be a non-empty array of permission contexts");
      }

      if (!Array.isArray(body.executions) || body.executions.length === 0) {
        throw new BadRequestError("executions must be a non-empty array of Execution objects");
      }

      const delegationManager =
        body.delegationManager ?? config.permissionsDelegationManager;

      if (!delegationManager) {
        throw new BadRequestError(
          "No delegation manager: pass one, or set " +
            "PERMISSIONS_DELEGATION_MANAGER to the ERC-7710 manager this " +
            "chain uses.",
        );
      }

      const transaction = buildRedeemDelegation({
        delegationManager: delegationManager as never,
        contexts: body.contexts as never,
        executions: body.executions.map((execution) => ({
          target: execution.target,
          value: BigInt(execution.value),
          callData: execution.callData,
        })) as never,
        ...(body.method === undefined ? {} : { method: body.method }),
      });

      res.json({
        network: config.network,
        chainId: config.chainId,
        broadcast: false,
        transaction,
      });
    } catch (error) {
      next(error);
    }
  },
);

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
