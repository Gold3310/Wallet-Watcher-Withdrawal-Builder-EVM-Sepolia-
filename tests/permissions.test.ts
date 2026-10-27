import { getBytes, parseEther, verifyMessage } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import {
  CONTEXT_TAG,
  buildGrantDigest,
  canonicalJson,
  decodePermissionsContext,
  encodePermissionsContext,
  hashPermission,
  hashPermissions,
  hashPolicies,
  selectorOf,
} from "../src/domain/permissions/encoding.js";
import {
  deriveSessionWallet,
  grantPermissions,
  inspectContext,
  listSessions,
  nowSeconds,
  redeemPermission,
  revokeSession,
  spendingCapOf,
  valueLimitOf,
} from "../src/domain/permissions/permission.service.js";
import type { Permission, Policy } from "../src/domain/permissions/types.js";
import { deriveWalletAtIndex } from "../src/domain/wallet/wallet.service.js";
import { getDatabase, resetDatabase } from "../src/infra/db/database.js";
import { resetProvider, setProvider } from "../src/infra/rpc/provider.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const DESTINATION = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function nativePermission(policies: Policy[] = []): Permission {
  return {
    type: "native-token-transfer",
    data: {},
    policies,
  };
}

function useMockProvider(): void {
  setProvider({
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getBalance: vi.fn().mockResolvedValue(parseEther("1")),
    broadcastTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
  } as never);
}

describe("permission encoding", () => {
  it("canonicalises JSON so key order never changes a hash", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("accepts both 4-byte selectors and full signatures", () => {
    expect(selectorOf("0xa9059cbb")).toBe("0xa9059cbb");
    expect(selectorOf("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(() => selectorOf()).toThrow("signature or 4-byte selector");
  });

  it("produces a stable permission hash that reacts to every field", () => {
    const base = nativePermission();
    expect(hashPermission(base)).toBe(hashPermission({ ...base }));

    expect(hashPermission(nativePermission([{ type: "spending-cap", data: { limit: "1" } }]))).not.toBe(
      hashPermission(base),
    );

    expect(
      hashPermission({
        type: "erc20-token-transfer",
        data: {},
        policies: [],
      }),
    ).not.toBe(hashPermission(base));

    expect(hashPolicies([])).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("round-trips a permissionsContext with an ERC tag", () => {
    const account = deriveWalletAtIndex(TEST_MNEMONIC, 0).address;
    const permissions = [nativePermission()];
    const expiry = nowSeconds() + 600;
    const signer = { type: "key", data: { id: account as `0x${string}` } } as const;

    const encoded = encodePermissionsContext({
      account,
      signer,
      expiry,
      permissionsHash: hashPermissions(permissions),
    });

    const context = decodePermissionsContext(encoded);

    expect(context.tag).toBe(CONTEXT_TAG);
    expect(context.account).toBe(account);
    expect(context.expiry).toBe(expiry);
    expect(context.permissionsHash).toBe(hashPermissions(permissions));
  });
});

describe("wallet_grantPermissions", () => {
  beforeEach(() => {
    resetDatabase();
    resetProvider();
    initializeWallets();
    useMockProvider();
  });

  it("returns the request a wallet sends and the response it gets back", () => {
    const { request, response, session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 3600,
      permissions: [
        {
          type: "contract-call",
          data: {
            address: "0x706aa5c8e5cc2c67da21ee220718f6f6b154e75c",
            calls: [{ signature: "transfer(address,uint256)" }],
          },
          policies: [],
        },
      ],
    });

    // Request: expiry is a duration in seconds.
    expect(request.expiry).toBe(3600);
    expect(request.signer.type).toBe("key");
    expect(request.signer.data.id).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(request.permissions[0].data.calls?.[0]?.signature).toBe(
      "transfer(address,uint256)",
    );

    // Response: expiry is absolute.
    expect(response.expiry).toBeGreaterThan(nowSeconds() + 3500);
    expect(response.grantedPermissions).toEqual(request.permissions);
    expect(response.permissionsContext.startsWith(CONTEXT_TAG)).toBe(true);

    expect(session.status).toBe("active");
    expect(session.spentWei).toBe("0");
    expect(session.remainingWei).toBeNull();
    expect(session.nonce).toBe(0);
    expect(session.permissionsContext).toBe(response.permissionsContext);
  });

  it("signs the grant digest with the account key", () => {
    const { session } = grantPermissions({
      fromWalletIndex: 1,
      expiry: 600,
      permissions: [nativePermission()],
    });

    const account = deriveWalletAtIndex(TEST_MNEMONIC, 1).address;
    expect(session.account).toBe(account);
    expect(verifyMessage(getBytes(session.grantDigest), session.grantSignature)).toBe(
      account,
    );

    const recomputed = buildGrantDigest({
      account,
      signer: { type: session.signer.type, data: { id: session.signer.id as `0x${string}` } },
      expiry: session.expiry,
      permissionsHash: session.permissionsHash as `0x${string}`,
    });
    expect(recomputed).toBe(session.grantDigest);
  });

  it("derives the session key from the account key plus a stored seed", () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    const accountKey = deriveWalletAtIndex(TEST_MNEMONIC, 0).privateKey;
    const row = getDatabase()
      .prepare("SELECT session_seed FROM permission_sessions WHERE id = ?")
      .get(session.id) as { session_seed: string };

    expect(deriveSessionWallet(accountKey, row.session_seed).address).toBe(
      session.signer.id,
    );
    expect(deriveSessionWallet(accountKey, "0x" + "22".repeat(32)).address).not.toBe(
      session.signer.id,
    );
    // The seed alone is not the key.
    expect(row.session_seed).not.toBe(accountKey);
  });

  it("validates the grant request", () => {
    expect(() =>
      grantPermissions({ fromWalletIndex: 0, permissions: [] }),
    ).toThrow("permissions must be a non-empty array");

    expect(() =>
      grantPermissions({
        fromWalletIndex: 0,
        permissions: [{ type: "nft-mint", data: {}, policies: [] } as never],
      }),
    ).toThrow("must be one of");

    expect(() =>
      grantPermissions({
        fromWalletIndex: 0,
        permissions: [nativePermission()],
        expiry: 0,
      }),
    ).toThrow("positive integer");

    expect(() =>
      grantPermissions({
        fromWalletIndex: 0,
        permissions: [nativePermission()],
        expiry: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("must not exceed");

    expect(() =>
      grantPermissions({ fromWalletIndex: 99, permissions: [nativePermission()] }),
    ).toThrow("does not exist");
  });

  it("lists and inspects sessions", () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    expect(listSessions().map((entry) => entry.id)).toContain(session.id);
    expect(listSessions(0).map((entry) => entry.id)).toContain(session.id);

    const inspected = inspectContext(session.permissionsContext);
    expect(inspected.known).toBe(true);
    expect(inspected.sessionId).toBe(session.id);
    expect(inspected.intact).toBe(true);
    expect(inspected.permissionsHash).toBe(session.permissionsHash);
  });
});

describe("session-key redemption", () => {
  beforeEach(() => {
    resetDatabase();
    resetProvider();
    initializeWallets();
    useMockProvider();
  });

  it("authorises a redemption with the session key and leaves no state on build", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    const result = await redeemPermission({
      sessionId: session.id,
      toAddress: DESTINATION,
      amountWei: parseEther("0.01").toString(),
      broadcast: false,
    });

    expect(result.authorization.recoveredSigner).toBe(session.signer.id);
    expect(result.authorization.sessionKeySignature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(
      verifyMessage(
        getBytes(result.authorization.actionDigest),
        result.authorization.sessionKeySignature,
      ),
    ).toBe(session.signer.id);

    expect(result.withdrawal.broadcast).toBe(false);
    expect(result.withdrawal.txHash).toBeUndefined();

    // Build-only redemptions do not consume the cap or the nonce.
    expect(result.session.nonce).toBe(0);
    expect(result.session.spentWei).toBe("0");
  });

  it("records spend and burns the nonce when broadcasting", async () => {
    const amount = parseEther("0.01");
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [
        nativePermission([
          { type: "spending-cap", data: { limit: parseEther("0.05").toString() } },
        ]),
      ],
    });

    const result = await redeemPermission({
      sessionId: session.id,
      toAddress: DESTINATION,
      amountWei: amount.toString(),
      broadcast: true,
    });

    expect(result.withdrawal.broadcast).toBe(true);
    expect(result.withdrawal.txHash).toBe(TX_HASH);
    expect(result.session.nonce).toBe(1);
    expect(result.session.spentWei).toBe(amount.toString());
    expect(BigInt(result.session.remainingWei!)).toBe(parseEther("0.04"));
  });

  it("refuses once the spending cap is exhausted", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [
        nativePermission([{ type: "spending-cap", data: { limit: "1000" } }]),
      ],
    });

    await expect(
      redeemPermission({
        sessionId: session.id,
        toAddress: DESTINATION,
        amountWei: "2000",
        broadcast: false,
      }),
    ).rejects.toThrow("exceeds the remaining spending cap");
  });

  it("refuses amounts above the per-action value limit", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [
        nativePermission([{ type: "value-limit", data: { limit: "1000" } }]),
      ],
    });

    await expect(
      redeemPermission({
        sessionId: session.id,
        toAddress: DESTINATION,
        amountWei: "1001",
        broadcast: false,
      }),
    ).rejects.toThrow("exceeds the per-action value-limit");
  });

  it("refuses to redeem a permission type it cannot execute", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [
        {
          type: "erc20-token-transfer",
          data: {
            address: "0x706aa5c8e5cc2c67da21ee220718f6f6b154e75c",
            calls: [{ signature: "transfer(address,uint256)" }],
          },
          policies: [],
        },
      ],
    });

    await expect(
      redeemPermission({
        sessionId: session.id,
        toAddress: DESTINATION,
        amountWei: "1000",
        broadcast: false,
      }),
    ).rejects.toThrow("does not grant 'native-token-transfer'");
  });

  it("refuses after expiry", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    getDatabase()
      .prepare("UPDATE permission_sessions SET expiry = ? WHERE id = ?")
      .run(nowSeconds() - 1, session.id);

    await expect(
      redeemPermission({
        sessionId: session.id,
        toAddress: DESTINATION,
        amountWei: "1000",
        broadcast: false,
      }),
    ).rejects.toThrow("expired");
  });

  it("refuses after revocation", async () => {
    const { session } = grantPermissions({
      fromWalletIndex: 0,
      expiry: 600,
      permissions: [nativePermission()],
    });

    const revoked = revokeSession(session.id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();

    await expect(
      redeemPermission({
        sessionId: session.id,
        toAddress: DESTINATION,
        amountWei: "1000",
        broadcast: false,
      }),
    ).rejects.toThrow("was revoked");
  });

  it("takes the strictest cap when several are granted", () => {
    expect(
      spendingCapOf([
        nativePermission([{ type: "spending-cap", data: { limit: "500" } }]),
        nativePermission([{ type: "spending-cap", data: { limit: "200" } }]),
      ]),
    ).toBe(200n);

    expect(valueLimitOf([nativePermission()])).toBeNull();
  });
});
