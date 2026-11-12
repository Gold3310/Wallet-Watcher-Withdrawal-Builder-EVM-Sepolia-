import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEther } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWallets } from "../src/domain/balance/balance.service.js";
import { deriveWalletAtIndex } from "../src/domain/wallet/wallet.service.js";
import {
  buildSnapshotPlan,
  parseSnapshot,
  processStandardV1Snapshot,
  StandardV1Snapshot,
} from "../src/domain/withdrawal/merkle.integration.js";
import { resetDatabase } from "../src/infra/db/database.js";
import { resetProvider, setProvider } from "../src/infra/rpc/provider.js";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

/** Wallet 0, 1 and 2 are the derived addresses below; the vault at `.1f98…`
 * and `.E2cC…` are not derived from this mnemonic. */
const WALLET_0 = deriveWalletAtIndex(TEST_MNEMONIC, 0).address;
const WALLET_1 = deriveWalletAtIndex(TEST_MNEMONIC, 1).address;
const WALLET_2 = deriveWalletAtIndex(TEST_MNEMONIC, 2).address;
const FOREIGN_VAULT = "0xE2cC063DEc5685718Bd57aAC6AEE9941b25b7c37";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("../data/standard-v1-sample.json", import.meta.url),
);

function loadSnapshot(): StandardV1Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as StandardV1Snapshot;
}

describe("standard-v1 snapshot", () => {
  beforeEach(() => {
    resetDatabase();
    resetProvider();
    initializeWallets();

    setProvider({
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      getBalance: vi.fn().mockResolvedValue(parseEther("1000")),
      broadcastTransaction: vi
        .fn()
        .mockResolvedValue({ hash: `0x${"ab".repeat(32)}` }),
    } as never);
  });

  it("computes net amounts from the leaf and the extra values", () => {
    const { breakdowns } = parseSnapshot(loadSnapshot());
    const [first] = breakdowns;

    // 100 ETH - 1 fee - 5 liability - 1 slashing - 0.00035 in fees
    expect(first.totalValueWei).toBe(parseEther("100").toString());
    expect(first.feeWei).toBe(parseEther("1").toString());
    expect(first.liabilitySharesWei).toBe(parseEther("5").toString());
    expect(first.slashingReserveWei).toBe(parseEther("1").toString());
    expect(first.infraFeeWei).toBe(parseEther("0.0001").toString());
    expect(first.liquidityFeeWei).toBe(parseEther("0.0002").toString());
    expect(first.reservationFeeWei).toBe(parseEther("0.00005").toString());
    expect(first.netAmountWei).toBe("92999650000000000000");
    expect(first.treeIndex).toBe(0);

    // `inOutDelta` and `prevFee` are reported, never deducted a second time.
    expect(first.inOutDeltaWei).toBe(parseEther("0.01").toString());
    expect(first.prevFeeWei).toBe(parseEther("0.0005").toString());
  });

  it("maps each vault address to the wallet index that holds it", () => {
    const plan = buildSnapshotPlan(loadSnapshot());

    expect(plan.entries.map((entry) => entry.address)).toEqual([
      WALLET_0,
      WALLET_1,
      WALLET_2,
    ]);
    expect(plan.entries.map((entry) => entry.fromWalletIndex)).toEqual([0, 1, 2]);

    // The foreign vault parses, but there is no wallet to pay it from.
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      address: FOREIGN_VAULT,
      reason: "not-a-wallet",
      netAmountWei: "92999650000000000000",
    });

    // 92.99965 + 46.499825 + 0.999 ETH. The fourth leaf is skipped, so its
    // 92.99965 ETH is not part of the total.
    expect(plan.totalNetWei).toBe(
      parseEther("140.498475").toString(),
    );
    expect(plan.totalNetEth).toBe("140.498475");
    expect(plan.network).toBe("sepolia");
    expect(plan.chainId).toBe(11155111);
    expect(plan.block).toEqual({
      blockHash: "0xf2f9057f5a232ced2a194d954886d5881457d44298850105e2e48011eff0217b",
      blockNumber: 26398720,
      timestamp: 1794484811,
    });
  });

  it("builds requests that carry the address, amount and actor", () => {
    const plan = buildSnapshotPlan(loadSnapshot(), {
      broadcast: true,
      actor: "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce",
    });

    expect(plan.entries[0].request).toEqual({
      fromWalletIndex: 0,
      toAddress: WALLET_0,
      amountWei: "92999650000000000000",
      broadcast: true,
      actor: "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce",
    });
    expect(plan.entries[1].request.amountWei).toBe("46499825000000000000");
  });

  it("signs nothing on a dry run", async () => {
    const run = await processStandardV1Snapshot(loadSnapshot());

    expect(run.executed).toBe(false);
    expect(run.results).toEqual([]);
    expect(run.entries.every((entry) => entry.request.broadcast === false)).toBe(true);
  });

  it("broadcasts each payable vault once when executing", async () => {
    const run = await processStandardV1Snapshot(loadSnapshot(), {
      execute: true,
      broadcast: true,
    });

    expect(run.executed).toBe(true);
    expect(run.results).toHaveLength(3);
    expect(run.results.every((result) => result.status !== "failed")).toBe(true);

    for (const result of run.results) {
      if (result.status === "failed") continue;
      expect(result.result.built.value).toBe(
        run.entries.find((entry) => entry.address === result.address)!.request
          .amountWei,
      );
      expect(result.result.built.chainId).toBe(11155111);
      expect(result.result.broadcast).toBe(true);
    }
  });

  it("records an evidence row that ties the run to its snapshot block", async () => {
    const run = await processStandardV1Snapshot(loadSnapshot(), {
      execute: true,
      broadcast: false,
    });

    expect(run.evidence.txHash).toBe(
      "snapshot:0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    );
    expect(run.evidence.blockNumber).toBe(26398720);
    expect(run.evidence.blockHash).toBe(
      "0xf2f9057f5a232ced2a194d954886d5881457d44298850105e2e48011eff0217b",
    );
    expect(run.evidence.contractAddress).toBe("standard-v1");
    expect(run.evidence.value).toBe(parseEther("140.498475").toString());

    const data = JSON.parse(run.evidence.data);
    expect(data.executed).toBe(true);
    expect(data.timestamp).toBe(1794484811);
    expect(data.entries).toHaveLength(3);
    expect(data.entries[0]).toMatchObject({
      address: WALLET_0,
      fromWalletIndex: 0,
      treeIndex: 0,
      amountWei: "92999650000000000000",
    });
    expect(data.skipped).toEqual([
      { address: FOREIGN_VAULT, reason: "not-a-wallet", netAmountWei: "92999650000000000000" },
    ]);
    expect(data.results).toHaveLength(3);
    expect(data.results[0].status).toBe("built");
  });

  it("records a dry run as not executed", async () => {
    const run = await processStandardV1Snapshot(loadSnapshot());

    expect(JSON.parse(run.evidence.data).executed).toBe(false);
    expect(JSON.parse(run.evidence.data).results).toEqual([]);
  });

  it("rejects a leaf whose deductions exceed its total value", () => {
    const snapshot = loadSnapshot();
    snapshot.extraValues = {};
    snapshot.values = [
      [WALLET_0, "1000", "2000", "0", "0", "0"],
    ];

    expect(() => parseSnapshot(snapshot)).toThrow(
      /deducts 2000 wei from a total value of 1000 wei/,
    );
  });

  it("rejects a leaf encoding it cannot read", () => {
    const snapshot = loadSnapshot();
    snapshot.leafEncoding = ["address", "uint256"];

    expect(() => parseSnapshot(snapshot)).toThrow(/Unsupported leafEncoding/);
  });

  it("rejects a snapshot that lists the same vault twice", () => {
    const snapshot = loadSnapshot();
    snapshot.values = [snapshot.values![0], snapshot.values![0]];

    expect(() => parseSnapshot(snapshot)).toThrow(/more than once/);
  });

  it("accepts the block fields nested instead of flat", () => {
    const snapshot = loadSnapshot();
    delete snapshot.blockHash;
    delete snapshot.blockNumber;
    delete snapshot.timestamp;
    snapshot.block = {
      blockHash: "0x" + "11".repeat(32),
      blockNumber: 26398721,
      timestamp: 1794484812,
    };

    expect(parseSnapshot(snapshot).block.blockNumber).toBe(26398721);
  });
});
