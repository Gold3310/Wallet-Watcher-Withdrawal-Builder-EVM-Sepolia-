import { parseUnits } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { trackedContractInterface } from "../src/domain/assets/abi.js";
import { deriveConfiguredWallets } from "../src/domain/wallet/wallet.service.js";
import {
  findWalletIndex,
  planWithdrawal,
} from "../src/domain/assets/withdraw.plan.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const HOLDER = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
const WITHDRAW_SELECTOR = "0x2e1a7d4d";

function providerWith(balance: string | null) {
  return {
    call: vi.fn().mockImplementation(async (tx: { to: string; data: string }) => {
      if (balance === null) {
        throw new Error("call reverted");
      }
      if (tx.data.startsWith("0x70a08231")) {
        return trackedContractInterface.encodeFunctionResult("balanceOf", [
          BigInt(balance),
        ]);
      }
      throw new Error(`unexpected call ${tx.data}`);
    }),
  };
}

describe("planning a withdrawal from an address this service cannot sign for", () => {
  it("says so, and routes it to the holder", async () => {
    const plan = await planWithdrawal(
      providerWith("7485000000000000000"),
      CONTRACT,
      { from: HOLDER, amountWei: "7485000000000000000", chainId: 1 },
    );

    expect(plan.canSignHere).toBe(false);
    expect(plan.walletIndex).toBeNull();
    expect(plan.route).toBe("external");
    expect(plan.blockers.join(" ")).toMatch(/not a wallet derived from/);
    expect(plan.blockers.join(" ")).toMatch(/nobody can redeem another address/);
  });

  it("produces the exact calldata the holder must sign", async () => {
    const plan = await planWithdrawal(
      providerWith("7485000000000000000"),
      CONTRACT,
      { from: HOLDER, amountWei: "7485000000000000000", chainId: 1 },
    );

    expect(plan.transaction.to).toBe(CONTRACT);
    expect(plan.transaction.data).toBe(
      WITHDRAW_SELECTOR +
        BigInt("7485000000000000000").toString(16).padStart(64, "0"),
    );
    // withdraw is not payable: no value is sent, ETH comes back to the caller.
    expect(plan.transaction.value).toBe("0");
    expect(plan.transaction.chainId).toBe(1);
  });

  it("never asks for a private key to work around it", async () => {
    const plan = await planWithdrawal(
      providerWith("7485000000000000000"),
      CONTRACT,
      { from: HOLDER, amountWei: "1000000000000000000", chainId: 1 },
    );

    expect(plan.instructions.join(" ")).toMatch(/will not accept a private key/);
    expect(plan.instructions.join(" ")).toMatch(/MetaMask|Ledger|wallet/);
  });
});

describe("planning one from a derived wallet", () => {
  const wallet = deriveConfiguredWallets()[0];

  it("routes it to the service and names the index", async () => {
    const plan = await planWithdrawal(providerWith("1000000000000000000"), CONTRACT, {
      from: wallet.address,
      amountWei: "1000000000000000000",
    });

    expect(plan.canSignHere).toBe(true);
    expect(plan.walletIndex).toBe(0);
    expect(plan.route).toBe("service");
    expect(plan.blockers).toEqual([]);
    expect(plan.instructions.join(" ")).toMatch(/assets\/unwrap/);
  });

  it("tells you to build it before broadcasting", async () => {
    const plan = await planWithdrawal(providerWith("1000000000000000000"), CONTRACT, {
      from: wallet.address,
      amountWei: "1000000000000000000",
    });

    expect(plan.instructions.join(" ")).toMatch(/"broadcast":false/);
    expect(plan.instructions.join(" ")).toMatch(/"broadcast":true/);
  });
});

describe("what the plan refuses to gloss over", () => {
  it("reports an unreadable balance as unknown, not zero", async () => {
    const plan = await planWithdrawal(providerWith(null), CONTRACT, {
      from: HOLDER,
      amountWei: "1000000000000000000",
    });

    expect(plan.balance).toBeNull();
    expect(plan.sufficient).toBeNull();
    expect(plan.blockers.join(" ")).toMatch(/could not be read/);
    expect(plan.blockers.join(" ")).toMatch(/not a zero balance/);
  });

  it("blocks a withdrawal larger than the balance", async () => {
    const plan = await planWithdrawal(providerWith("1000000000000000000"), CONTRACT, {
      from: HOLDER,
      amountWei: "2000000000000000000",
    });

    expect(plan.sufficient).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/less than/);
  });

  it("rejects an invalid address", async () => {
    await expect(
      planWithdrawal(providerWith("0"), CONTRACT, {
        from: "not-an-address",
        amountWei: "1",
      }),
    ).rejects.toThrow(/not a valid address/);
  });

  it("rejects a zero amount", async () => {
    await expect(
      planWithdrawal(providerWith("0"), CONTRACT, {
        from: HOLDER,
        amountWei: "0",
      }),
    ).rejects.toThrow(/greater than zero/);
  });

  it("rejects a non-numeric amount", async () => {
    await expect(
      planWithdrawal(providerWith("0"), CONTRACT, {
        from: HOLDER,
        amountWei: "lots",
      }),
    ).rejects.toThrow(/must be an integer/);
  });

  it("does not require the whole balance", async () => {
    // A plan is for a named amount. Sweeping is a separate decision.
    const plan = await planWithdrawal(
      providerWith(parseUnits("7.485", 18).toString()),
      CONTRACT,
      { from: HOLDER, amountWei: parseUnits("1", 18).toString(), chainId: 1 },
    );

    expect(plan.amountWei).toBe("1000000000000000000");
    expect(plan.balance).toBe("7485000000000000000");
    expect(plan.sufficient).toBe(true);
  });
});

describe("matching an address to a wallet", () => {
  it("finds a derived wallet regardless of input case", () => {
    expect(findWalletIndex(deriveConfiguredWallets()[0].address.toLowerCase())).toBe(0);
  });

  it("returns null rather than a wrong guess", () => {
    expect(findWalletIndex(HOLDER)).toBeNull();
    expect(findWalletIndex("nonsense")).toBeNull();
  });
});
