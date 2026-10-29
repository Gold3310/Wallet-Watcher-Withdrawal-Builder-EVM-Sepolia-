/**
 * Idempotency for mutating requests.
 *
 * `POST /withdrawals` and `POST /permissions/:id/redeem` move funds, so a
 * client that retries on a timeout must not be able to send twice. A caller
 * sends an `Idempotency-Key` header; the first request records the request
 * hash and stores its response, and any replay of the same key returns the
 * stored response instead of acting again.
 *
 * Reusing a key with a different body is rejected rather than silently
 * answered with the old response.
 */
import { createHash } from "node:crypto";
import {
  completeIdempotentRequest,
  getDatabase,
  insertIdempotencyRecord,
  readIdempotencyRecord,
} from "../../infra/db/database.js";
import { canonicalJson } from "../../util/canonical.js";

export interface IdempotencyReplay {
  kind: "replay";
  status: number;
  body: Record<string, unknown>;
}

export interface IdempotencyFresh {
  kind: "fresh";
  key: string;
}

export interface IdempotencyRejected {
  kind: "rejected";
  reason: "in-flight" | "payload-mismatch";
}

export type IdempotencyStart =
  | IdempotencyFresh
  | IdempotencyReplay
  | IdempotencyRejected;

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body ?? null)).digest("hex");
}

export function startIdempotentRequest(params: {
  key: string;
  scope: string;
  actor: string;
  requestHash: string;
}): IdempotencyStart {
  const existing = readIdempotencyRecord(params.key);

  if (existing) {
    if (existing.request_hash !== params.requestHash) {
      return { kind: "rejected", reason: "payload-mismatch" };
    }

    if (existing.status === "completed" && existing.response) {
      return {
        kind: "replay",
        status: existing.status_code ?? 200,
        body: JSON.parse(existing.response) as Record<string, unknown>,
      };
    }

    return { kind: "rejected", reason: "in-flight" };
  }

  try {
    insertIdempotencyRecord({
      key: params.key,
      scope: params.scope,
      actor: params.actor,
      requestHash: params.requestHash,
    });
  } catch {
    // Lost a race against a concurrent request with the same key.
    return startIdempotentRequest(params);
  }

  return { kind: "fresh", key: params.key };
}

export function finishIdempotentRequest(
  key: string,
  status: number,
  body: unknown,
): void {
  completeIdempotentRequest(key, status, JSON.stringify(body));
}

/** Drop the record so the caller can retry with the same key after a failure. */
export function abandonIdempotentRequest(key: string): void {
  getDatabase().prepare("DELETE FROM idempotency WHERE key = ?").run(key);
}
