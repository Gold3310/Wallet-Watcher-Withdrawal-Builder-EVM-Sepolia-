import { getBytes, Interface, solidityPacked, ZeroAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { config } from "../src/config/index.js";
import {
  assertChainSupported,
  expiryRuleOf,
  getSupportedExecutionPermissions,
  SPEC_PERMISSION_TYPES,
  toChainIdHex,
  toExpiryDuration,
  toInternalPermission,
  toPermissionResponse,
  translateRequest,
  type PermissionRequest,
  type SpecPermission,
} from "../src/domain/permissions/erc7715.js";
import {
  EXECUTION_MODES,
  buildRedeemDelegation,
  buildSingleRedemption,
  encodeExecution,
  redeemDelegationInterface,
} from "../src/domain/permissions/redeem7715.js";

const CHAIN = toChainIdHex(config.chainId);
const TO = "0x016562aA41A8697720ce0943F003141f5dEAe006";
const OTHER_CHAIN = config.chainId === 1 ? "0xaa36a7" : "0x1";
const NOW = 1_700_000_000;

const allowance = (hex: string): SpecPermission => ({
  type: SPEC_PERMISSION_TYPES.nativeTokenAllowance,
  isAdjustmentAllowed: false,
  data: { allowance: hex },
});

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    chainId: CHAIN,
    to: TO,
    permission: allowance("0x0DE0B6B3A7640000"), // 1 ETH
    rules: [{ type: "expiry", data: { timestamp: NOW + 3600 } }],
    ...overrides,
  };
}

describe("chain scoping", () => {
  it("accepts the chain this service is configured for", () => {
    expect(assertChainSupported(CHAIN)).toBe(config.chainId);
  });

  it("refuses a permission scoped to another chain", () => {
    expect(() => assertChainSupported(OTHER_CHAIN)).toThrow(
      /is not the chain this service is configured for/,
    );
  });

  it("refuses anything that is not a hex chain id", () => {
    expect(() => assertChainSupported(1)).toThrow(/hex-encoded string/);
    expect(() => assertChainSupported("mainnet")).toThrow(/hex-encoded string/);
    expect(() => assertChainSupported("0x0")).toThrow(/not a valid chain id/);
  });
});

describe("translating a spec permission", () => {
  it("turns an allowance into a spending cap", () => {
    const internal = toInternalPermission(
      allowance("0x0DE0B6B3A7640000"), // 1 ETH in hex wei
    );

    expect(internal.type).toBe("native-token-transfer");
    expect(internal.policies).toEqual([
      { type: "spending-cap", data: { limit: "1000000000000000000" } },
    ]);
  });

  it("requires isAdjustmentAllowed, since attenuation consent is the point", () => {
    expect(() =>
      toInternalPermission({
        type: "native-token-allowance",
        data: { allowance: "0x1" },
      } as never),
    ).toThrow(/isAdjustmentAllowed must be a boolean/);
  });

  it("rejects a type it does not enforce", () => {
    expect(() =>
      toInternalPermission({
        type: "erc20-token-allowance",
        isAdjustmentAllowed: true,
        data: {},
      }),
    ).toThrow(/Unsupported permission type/);
  });

  it("refuses to silently drop an allowance on a type that ignores it", () => {
    expect(() =>
      toInternalPermission({
        type: "contract-call",
        isAdjustmentAllowed: true,
        data: { target: TO, allowance: "0x1" },
      }),
    ).toThrow(/does not accept data\.allowance/);
  });

  it("rejects a non-positive allowance", () => {
    expect(() => toInternalPermission(allowance("0x0"))).toThrow(
      /positive allowance/,
    );
  });

  it("reads a contract-call target", () => {
    const internal = toInternalPermission({
      type: "contract-call",
      isAdjustmentAllowed: false,
      data: { target: TO },
    });

    expect(internal.type).toBe("contract-call");
    expect(internal.data.address).toBe(TO);
  });
});

describe("expiry rules", () => {
  it("defaults when no expiry rule is sent", () => {
    expect(toExpiryDuration(undefined, NOW)).toBe(
      config.permissionsDefaultExpirySeconds,
    );
  });

  it("converts an absolute timestamp into a duration", () => {
    expect(
      toExpiryDuration([{ type: "expiry", data: { timestamp: NOW + 600 } }], NOW),
    ).toBe(600);
  });

  it("refuses a timestamp already in the past", () => {
    expect(() =>
      toExpiryDuration([{ type: "expiry", data: { timestamp: NOW - 1 } }], NOW),
    ).toThrow(/already in the past/);
  });

  it("refuses to stretch past the configured maximum", () => {
    const tooFar = NOW + config.permissionsMaxExpirySeconds + 1;
    expect(() =>
      toExpiryDuration([{ type: "expiry", data: { timestamp: tooFar } }], NOW),
    ).toThrow(/exceeds the maximum/);
  });

  it("finds the expiry rule among others", () => {
    expect(
      expiryRuleOf([
        { type: "other", data: {} },
        { type: "expiry", data: { timestamp: 42 } },
      ])?.data.timestamp,
    ).toBe(42);
    expect(expiryRuleOf([{ type: "other", data: {} }])).toBeNull();
  });
});

describe("translateRequest", () => {
  it("reduces a spec request to what the grant engine needs", () => {
    const translated = translateRequest(request(), NOW);

    expect(translated.chainId).toBe(config.chainId);
    expect(translated.to).toBe(TO);
    expect(translated.from).toBeNull();
    expect(translated.signerType).toBe("account");
    expect(translated.expiry).toBe(3600);
    expect(translated.isAdjustmentAllowed).toBe(false);
    expect(translated.permissions).toHaveLength(1);
  });

  it("carries the granting account when the request names one", () => {
    const translated = translateRequest(
      request({ from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
      NOW,
    );

    expect(translated.from).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });
});

describe("advertising what is supported", () => {
  it("lists only types the enforcement path checks", () => {
    const supported = getSupportedExecutionPermissions();

    expect(Object.keys(supported).sort()).toEqual([
      "contract-call",
      "native-token-allowance",
      "native-token-transfer",
    ]);
  });

  it("scopes every entry to this chain with the expiry rule", () => {
    const supported = getSupportedExecutionPermissions();

    for (const entry of Object.values(supported)) {
      expect(entry.chainIds).toEqual([CHAIN]);
      expect(entry.ruleTypes).toEqual(["expiry"]);
    }
  });
});

describe("the response shape", () => {
  const granted = {
    permissionsContext: "0xdeadbeef",
    permissions: [],
    expiry: NOW + 3600,
    account: TO,
    signer: { type: "account" as const, id: TO },
    status: "active",
  };

  it("echoes the request and attaches the context", () => {
    const response = toPermissionResponse(request(), granted);

    expect(response.context).toBe("0xdeadbeef");
    expect(response.to).toBe(TO);
    expect(response.permission.type).toBe("native-token-allowance");
    expect(response.rules).toEqual([
      { type: "expiry", data: { timestamp: NOW + 3600 } },
    ]);
  });

  it("does not invent a delegation manager", () => {
    const response = toPermissionResponse(request(), granted);

    if (config.permissionsDelegationManager === null) {
      expect(response.delegationManager).toBe(ZeroAddress);
      expect(response.warning).toMatch(/is not configured/);
    } else {
      expect(response.delegationManager).toBe(
        config.permissionsDelegationManager,
      );
    }
  });
});

describe("building a redemption", () => {
  const MANAGER = "0xc186fA914353c44b2E33eBE05f21846F1048bEda";
  const CONTEXT = "0x77150001" + "11".repeat(32);

  it("packs an execution the way the delegation manager expects", () => {
    const execution = {
      target: TO as `0x${string}`,
      value: 10n ** 16n,
      callData: "0x" as `0x${string}`,
    };

    expect(encodeExecution(execution)).toBe(
      solidityPacked(
        ["address", "uint256", "bytes"],
        [execution.target, execution.value, execution.callData],
      ),
    );
  });

  it("defaults every mode to SingleDefault", () => {
    expect(EXECUTION_MODES.singleDefault).toBe(
      "0x" + "00".repeat(32),
    );
  });

  it("encodes three parallel arrays", () => {
    const built = buildRedeemDelegation({
      delegationManager: MANAGER as `0x${string}`,
      contexts: [CONTEXT as `0x${string}`],
      executions: [
        { target: TO as `0x${string}`, value: 10n ** 16n, callData: "0x" },
      ],
    });

    expect(built.to).toBe(MANAGER);
    expect(built.method).toBe("redeemDelegation");

    const decoded = redeemDelegationInterface.decodeFunctionData(
      "redeemDelegation",
      built.data,
    );
    expect(decoded[0]).toEqual([CONTEXT]);
    expect(decoded[1]).toEqual([EXECUTION_MODES.singleDefault]);
    expect(decoded[2]).toEqual([
      solidityPacked(
        ["address", "uint256", "bytes"],
        [TO, 10n ** 16n, "0x"],
      ),
    ]);
  });

  it("supports both spellings, since deployments differ", () => {
    const iface = new Interface([
      "function redeemDelegations(bytes[],bytes32[],bytes[]) external",
    ]);

    const singular = buildRedeemDelegation({
      delegationManager: MANAGER as `0x${string}`,
      contexts: [CONTEXT as `0x${string}`],
      executions: [
        { target: TO as `0x${string}`, value: 1n, callData: "0x" },
      ],
    });
    const plural = buildSingleRedemption(
      MANAGER as `0x${string}`,
      CONTEXT as `0x${string}`,
      { target: TO as `0x${string}`, value: 1n, callData: "0x" },
      "redeemDelegations",
    );

    // Same arguments, different selector — which is exactly the trap.
    expect(singular.data.slice(0, 10)).not.toBe(plural.data.slice(0, 10));
    expect(singular.data.slice(10)).toBe(plural.data.slice(10));
    expect(() => iface.decodeFunctionData("redeemDelegations", plural.data)).not.toThrow();
  });

  it("refuses mismatched parallel arrays", () => {
    expect(() =>
      buildRedeemDelegation({
        delegationManager: MANAGER as `0x${string}`,
        contexts: [CONTEXT as `0x${string}`],
        executions: [],
      }),
    ).toThrow(/execution\(s\) to match/);
  });

  it("refuses an empty redemption", () => {
    expect(() =>
      buildRedeemDelegation({
        delegationManager: MANAGER as `0x${string}`,
        contexts: [],
        executions: [],
      }),
    ).toThrow(/At least one permission context/);
  });

  it("produces real calldata, not a stub", () => {
    const built = buildSingleRedemption(
      MANAGER as `0x${string}`,
      CONTEXT as `0x${string}`,
      { target: TO as `0x${string}`, value: 1n, callData: "0x" },
    );

    expect(getBytes(built.data).length).toBeGreaterThan(100);
  });
});
