import { formatEther, parseUnits } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { trackedContractInterface } from "../src/domain/assets/abi.js";
import {
  buildHolderReport,
  HolderOfInterest,
  readHolderReport,
} from "../src/domain/assets/holders.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const OWNER = "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce";
const CREATOR = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";
const WALLET_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const SUPPLY = parseUnits("42.591", 18);
const RESERVE = parseUnits("42.591", 18);

const holder = (
  label: string,
  address: string,
  signableByService: boolean,
): HolderOfInterest => ({ label, address, signableByService });

/** The standard set: the claim being tested first, then roles, then wallets. */
const DEFAULT_HOLDERS: HolderOfInterest[] = [
  holder("the contract itself", CONTRACT, false),
  holder("service owner address", OWNER, false),
  holder("contract deployer", CREATOR, false),
  holder("derived wallet 0", WALLET_0, true),
];

function report(
  balances: (bigint | null)[],
  overrides: Partial<Parameters<typeof buildHolderReport>[0]> = {},
) {
  return buildHolderReport({
    contract: CONTRACT,
    holders: DEFAULT_HOLDERS,
    decimals: 18,
    symbol: "ABT",
    totalSupply: SUPPLY,
    ethReserve: RESERVE,
    balances,
    ...overrides,
  });
}

describe("the contract's own balance — the claim this settles", () => {
  it("reports zero and says the contract is the ledger, not a holder", () => {
    const result = report([0n, 0n, 0n, 0n]);

    expect(result.contractOwnBalanceRaw).toBe("0");
    expect(result.verdict).toMatch(
      /The contract holds none of ABT in itself/,
    );
    expect(result.verdict).toMatch(
      /not a holder of it/,
    );
  });

  it("handles the rare case of a contract holding its own token", () => {
    const result = report([parseUnits("1", 18), 0n, 0n, 0n]);

    expect(result.contractOwnBalanceRaw).toBe(parseUnits("1", 18).toString());
    expect(result.verdict).toMatch(/unusual for a WETH-style token/);
    expect(result.verdict).toMatch(/not spendable by the owner/);
  });

  it("counts the contract's own balance in the reported total", () => {
    const result = report([parseUnits("1", 18), 0n, 0n, parseUnits("2", 18)]);
    expect(result.reportedTotalRaw).toBe(parseUnits("3", 18).toString());
  });
});

describe("who can actually take the ETH", () => {
  it("marks a signable holder with a backed balance as able to withdraw", () => {
    const result = report([0n, 0n, 0n, parseUnits("5", 18)]);
    const wallet = result.holders[3];

    expect(wallet.balanceRaw).toBe(parseUnits("5", 18).toString());
    expect(wallet.redeemableEth).toBe("5.0");
    expect(wallet.canWithdrawNow).toBe(true);
    expect(wallet.signableByService).toBe(true);
    expect(result.verdict).toMatch(/can turn into ETH right now/);
  });

  it("caps redemption at the reserve and refuses when it is short", () => {
    const result = report([0n, 0n, 0n, parseUnits("5", 18)], {
      ethReserve: parseUnits("1", 18),
    });
    const wallet = result.holders[3];

    expect(wallet.redeemableEth).toBe("1.0");
    expect(wallet.canWithdrawNow).toBe(false);
  });

  it("does not offer ETH for an address the service cannot sign for", () => {
    const result = report([0n, parseUnits("5", 18), 0n, 0n]);
    const owner = result.holders[1];

    // A real balance, reported honestly — but not one this service can move.
    expect(owner.balanceRaw).toBe(parseUnits("5", 18).toString());
    expect(owner.canWithdrawNow).toBe(true);
    expect(owner.signableByService).toBe(false);
    expect(result.verdict).toMatch(/No address this service can sign for/);
  });

  it("says plainly what does not help when nothing is held", () => {
    const verdict = report([0n, 0n, 0n, 0n]).verdict;

    expect(verdict).toMatch(/not reachable from here/);
    expect(verdict).toMatch(/Not by the owner/);
    expect(verdict).toMatch(/not by the deployer/);
    expect(verdict).toMatch(/deriving another wallet/);
    expect(verdict).toMatch(/only by holding the token/);
  });
});

describe("accounting", () => {
  it("surfaces supply held outside the reported addresses", () => {
    const result = report([0n, 0n, 0n, parseUnits("5", 18)]);

    expect(result.unaccountedRaw).toBe(parseUnits("37.591", 18).toString());
    expect(result.unaccountedFormatted).toBe("37.591");
  });

  it("leaves nothing unaccounted when every holder is listed", () => {
    const result = report([0n, 0n, 0n, SUPPLY]);
    expect(result.unaccountedRaw).toBe("0");
  });

  it("computes share of supply", () => {
    const result = report([0n, 0n, 0n, parseUnits("5", 18)]);
    expect(result.holders[3].shareOfSupply).toBe("11.7395");
  });

  it("concludes nothing when supply cannot be read", () => {
    const result = report([0n, 0n, 0n, 0n], { totalSupply: null });

    expect(result.totalSupplyRaw).toBeNull();
    expect(result.unaccountedRaw).toBeNull();
    expect(result.verdict).toMatch(/nothing is concluded here/);
  });
});

describe("reads that fail", () => {
  it("records the failure per holder without inventing a balance", () => {
    const result = report([null, 0n, 0n, 0n]);
    const row = result.holders[0];

    expect(row.balanceRaw).toBeNull();
    expect(row.balanceFormatted).toBeNull();
    expect(row.canWithdrawNow).toBeNull();
    expect(row.error).toMatch(/balanceOf read failed/);
  });
});

describe("readHolderReport against a provider", () => {
  it("asks the chain for every holder, including the contract itself", async () => {
    const balances: Record<string, bigint> = {
      [CONTRACT.toLowerCase()]: 0n,
      [OWNER.toLowerCase()]: 0n,
      [CREATOR.toLowerCase()]: 0n,
      [WALLET_0.toLowerCase()]: parseUnits("5", 18),
    };

    const seen: string[] = [];
    const provider = {
      getBalance: vi.fn().mockResolvedValue(RESERVE),
      call: vi.fn(async ({ to, data }: { to: string; data: string }) => {
        const fragment = trackedContractInterface.getFunction(
          data.slice(0, 10),
        );

        if (fragment?.name === "balanceOf") {
          const [queried] = trackedContractInterface.decodeFunctionData(
            "balanceOf",
            data,
          ) as [string];
          seen.push(queried.toLowerCase());
          return trackedContractInterface.encodeFunctionResult("balanceOf", [
            balances[queried.toLowerCase()] ?? 0n,
          ]);
        }
        if (fragment?.name === "totalSupply") {
          return trackedContractInterface.encodeFunctionResult("totalSupply", [
            SUPPLY,
          ]);
        }
        if (fragment?.name === "decimals") {
          return trackedContractInterface.encodeFunctionResult("decimals", [18]);
        }
        if (fragment?.name === "symbol") {
          return trackedContractInterface.encodeFunctionResult("symbol", [
            "ABT",
          ]);
        }
        throw new Error(`unexpected call: ${fragment?.name}`);
      }),
    };

    const result = await readHolderReport(
      provider as never,
      CONTRACT,
      DEFAULT_HOLDERS,
    );

    // The whole point: the contract's own balance is queried, not assumed.
    expect(seen).toContain(CONTRACT.toLowerCase());
    expect(seen).toHaveLength(4);

    expect(result.symbol).toBe("ABT");
    expect(result.contractOwnBalanceRaw).toBe("0");
    expect(result.ethReserveFormatted).toBe(formatEther(RESERVE).toString());
    expect(result.holders[3].redeemableEth).toBe("5.0");
    expect(result.verdict).toMatch(/can turn into ETH right now/);
  });
});
