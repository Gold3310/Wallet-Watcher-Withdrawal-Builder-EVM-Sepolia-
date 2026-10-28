/**
 * Idempotency-Key handling for routes that move funds.
 *
 * A replay returns the stored response; a key reused with a different body is
 * rejected rather than silently answered with the old one. Keys are required
 * whenever a request will broadcast, since a client retry on a timeout must
 * never be able to send twice.
 */
import type { NextFunction, Request, Response } from "express";
import {
  abandonIdempotentRequest as dropIdempotencyRecord,
  finishIdempotentRequest,
  hashRequestBody,
  startIdempotentRequest,
} from "../../domain/idempotency/idempotency.service.js";
import { actorId } from "./auth.js";

const MAX_KEY_LENGTH = 200;

export interface IdempotentContext {
  key: string | null;
}

/**
 * Returns `null` when a response has already been sent (replay or rejected
 * key), in which case the route must stop.
 */
export function beginIdempotentRequest(
  req: Request,
  res: Response,
  scope: string,
  body: unknown,
  requireKey: boolean,
): IdempotentContext | null {
  const key = req.get("idempotency-key")?.trim();

  if (!key) {
    if (requireKey) {
      res.status(400).json({
        error: "Idempotency-Key header is required when broadcast is true",
      });
      return null;
    }
    return { key: null };
  }

  if (key.length > MAX_KEY_LENGTH) {
    res.status(400).json({ error: "Idempotency-Key is too long" });
    return null;
  }

  const started = startIdempotentRequest({
    key,
    scope,
    actor: actorId(req),
    requestHash: hashRequestBody(body),
  });

  if (started.kind === "replay") {
    res
      .status(started.status)
      .json({ ...started.body, idempotentReplay: true });
    return null;
  }

  if (started.kind === "rejected") {
    res.status(409).json({
      error:
        started.reason === "in-flight"
          ? "A request with this Idempotency-Key is already in flight"
          : "Idempotency-Key was reused with a different request body",
    });
    return null;
  }

  return { key };
}

export function completeIdempotentRequest(
  context: IdempotentContext,
  status: number,
  body: unknown,
): void {
  if (context.key) {
    finishIdempotentRequest(context.key, status, body);
  }
}

export function abandonIdempotentRequest(
  context: IdempotentContext,
): void {
  if (context.key) {
    dropIdempotencyRecord(context.key);
  }
}
