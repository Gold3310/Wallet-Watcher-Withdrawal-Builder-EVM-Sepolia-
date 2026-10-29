/**
 * Bearer-token authentication for the API.
 *
 * Tokens come from `API_TOKENS` as `<id>:<secret>` pairs. The id is the actor
 * recorded against every withdrawal, so actions are attributable. Comparison
 * is constant-time: secrets are compared by SHA-256 digest with
 * `timingSafeEqual` so neither the length nor the matching prefix leaks.
 *
 * When no tokens are configured the API runs open and every request is
 * attributed to `anonymous`. Mainnet refuses to start in that state.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { config } from "../../config/index.js";

export interface Actor {
  id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (config.apiTokens.size === 0) {
    req.actor = { id: "anonymous" };
    next();
    return;
  }

  const header = req.get("authorization");

  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const presented = header.slice(7).trim();
  if (!presented) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  for (const [id, secret] of config.apiTokens) {
    if (secretMatches(presented, secret)) {
      req.actor = { id };
      next();
      return;
    }
  }

  res.status(401).json({ error: "Invalid API token" });
}

export function actorId(req: Request): string {
  return req.actor?.id ?? "anonymous";
}

/**
 * Rejects any actor that is not the configured sole owner.
 *
 * `OWNER_ADDRESS` is validated against `API_TOKENS` at startup, so in a
 * correctly configured process this never fires — an unauthorised principal
 * cannot get past `authenticate` with a different id. It is here so the
 * guarantee holds even if credentials are later reloaded or misconfigured:
 * the check is on the request, not only on the boot-time config.
 */
export function authorizeOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const owner = config.ownerAddress;

  if (owner && actorId(req).toLowerCase() !== owner.toLowerCase()) {
    res.status(403).json({
      error: `Forbidden: only ${owner} may perform this action`,
    });
    return;
  }

  next();
}
