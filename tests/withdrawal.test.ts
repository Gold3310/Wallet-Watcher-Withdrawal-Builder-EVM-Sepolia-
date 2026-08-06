import { parseEther, Transaction } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { deriveWalletAtIndex } from "../src/domain/wallet/wallet.service.js";
import {
  buildWithdrawalTransaction,
  normalizeDestinationAddress,
  parseAmountWei,
} from "../src/domain/withdrawal/withdrawal.service.js";
import { resetDatabase } from "../src/infra/db/database.js";
import { setProvider, resetProvider } from "../src/infra/rpc/provider.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

describe("withdrawal builder", () => {
  beforeEach(() => {
    resetDatabase();
    resetProvider();
    initializeWallets();

    const mockProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      getBalance: vi.fn().mockResolvedValue(parseEther("1")),
      broadcastTransaction: vi.fn(),
    };

    setProvider(mockProvider as never);
  });

  it("parses and validates destination addresses", () => {
    expect(
      normalizeDestinationAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    ).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("rejects invalid withdrawal amounts", () => {
    expect(() => parseAmountWei("0")).toThrow(
      "Amount must be greater than zero",
    );
    expect(() => parseAmountWei("not-a-number")).toThrow(
      "amountWei must be a valid unsigned integer string",
    );
  });

  it("builds a signed EIP-1559 transfer transaction", async () => {
    const built = await buildWithdrawalTransaction({
      fromWalletIndex: 0,
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      amountWei: parseEther("0.01").toString(),
      broadcast: false,
    });

    expect(built.from).toBe(deriveWalletAtIndex(TEST_MNEMONIC, 0).address);
    expect(built.to).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(built.value).toBe(parseEther("0.01").toString());
    expect(built.chainId).toBe(11155111);
    expect(built.gasLimit).toBe("21000");
    expect(built.serialized.startsWith("0x02")).toBe(true);
    expect(built.signature.r).toMatch(/^0x[0-9a-f]+$/i);
    expect(built.signature.s).toMatch(/^0x[0-9a-f]+$/i);

    const parsed = Transaction.from(built.serialized);
    expect(parsed.hash).toBe(built.hash);
    expect(parsed.to).toBe(built.to);
    expect(parsed.value).toBe(BigInt(built.value));
  });
});
