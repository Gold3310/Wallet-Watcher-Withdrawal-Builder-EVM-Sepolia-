import type { AddressInfo } from "node:net";
import { parseEther, parseUnits } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { erc20Interface } from "../src/domain/assets/asset.service.js";
import { withConfig } from "./helpers/withConfig.js";

const TOKEN = "0x32C3cE734cf52F9429C8a8eC2982e4fd714960Ed";
const OTHER_TOKEN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

const BASE_ENV: Record<string, string | undefined> = {
  CHAIN: undefined,
  MAINNET_ENABLED: undefined,
  WALLET_MNEMONIC: TEST_MNEMONIC,
  WALLET_COUNT: "3",
  SEPOLIA_RPC_URL: "https://sepolia.example",
  DATABASE_PATH: ":memory:",
  API_TOKENS: undefined,
  TRACKED_TOKENS: undefined,
};

interface MockOptions {
  nativeWei?: bigint;
  balances?: Record<string, bigint>;
  decimals?: Record<string, number>;
  symbols?: Record<string, string>;
  /** Calls to make revert, keyed by lowercase token address. */
  failing?: Record<string, string[]>;
}

function mockProvider(options: MockOptions = {}) {
  return {
    getBalance: vi.fn().mockResolvedValue(options.nativeWei ?? parseEther("2")),
    call: vi.fn(async ({ to, data }: { to: string; data: string }) => {
      const key = to.toLowerCase();
      const name = erc20Interface.getFunction(data.slice(0, 10))?.name;

      if (options.failing?.[key]?.includes(name ?? "")) {
        throw new Error(`${name} reverted`);
      }

      if (name === "balanceOf") {
        return erc20Interface.encodeFunctionResult("balanceOf", [
          options.balances?.[key] ?? 0n,
        ]);
      }

      if (name === "decimals") {
        return erc20Interface.encodeFunctionResult("decimals", [
          options.decimals?.[key] ?? 18,
        ]);
      }

      if (name === "symbol") {
        return erc20Interface.encodeFunctionResult("symbol", [
          options.symbols?.[key] ?? "TST",
        ]);
      }

      throw new Error(`unexpected call: ${name}`);
    }),
  };
}

async function withAssets(
  env: Record<string, string | undefined>,
  fn: (ctx: {
    provider: ReturnType<typeof mockProvider>;
    assets: typeof import("../src/domain/assets/asset.service.js");
  }) => Promise<void>,
  options: MockOptions = {},
): Promise<void> {
  await withConfig({ ...BASE_ENV, ...env }, async () => {
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const database = await import("../src/infra/db/database.js");
    const assets = await import("../src/domain/assets/asset.service.js");

    const provider = mockProvider(options);
    initializeWallets();
    setProvider(provider as never);

    try {
      await fn({ provider, assets });
    } finally {
      database.closeDatabase();
    }
  });
}

describe("asset reporting", () => {
  it("reports native and token balances with decimals applied", async () => {
    await withAssets(
      { TRACKED_TOKENS: TOKEN },
      async ({ assets }) => {
        const wallets = await assets.getAllWalletAssets();

        expect(wallets).toHaveLength(3);
        const first = wallets[0]!;

        expect(first.nativeEth).toBe("2.0");
        expect(first.tokens).toHaveLength(1);
        expect(first.tokens[0]!.address).toBe(TOKEN);
        expect(first.tokens[0]!.symbol).toBe("TST");
        expect(first.tokens[0]!.decimals).toBe(18);
        expect(first.tokens[0]!.error).toBeNull();
      },
      { balances: { [TOKEN.toLowerCase()]: parseUnits("1234.5", 18) } },
    );
  });

  it("formats balances using the token's own decimals", async () => {
    await withAssets(
      { TRACKED_TOKENS: TOKEN },
      async ({ assets }) => {
        const asset = await assets.getWalletAssetsByIndex(0);
        expect(asset.tokens[0]!.balanceRaw).toBe(parseUnits("500", 6).toString());
        expect(asset.tokens[0]!.balanceFormatted).toBe("500.0");
      },
      {
        balances: { [TOKEN.toLowerCase()]: parseUnits("500", 6) },
        decimals: { [TOKEN.toLowerCase()]: 6 },
        symbols: { [TOKEN.toLowerCase()]: "USDC" },
      },
    );
  });

  it("still reports a balance when symbol() reverts", async () => {
    await withAssets(
      { TRACKED_TOKENS: TOKEN },
      async ({ assets }) => {
        const asset = await assets.getWalletAssetsByIndex(0);

        expect(asset.tokens[0]!.symbol).toBeNull();
        expect(asset.tokens[0]!.balanceRaw).toBe(parseUnits("7", 18).toString());
        expect(asset.tokens[0]!.error).toBeNull();
      },
      {
        balances: { [TOKEN.toLowerCase()]: parseUnits("7", 18) },
        failing: { [TOKEN.toLowerCase()]: ["symbol"] },
      },
    );
  });

  it("reports an error instead of throwing when balanceOf reverts", async () => {
    await withAssets(
      { TRACKED_TOKENS: `${TOKEN},${OTHER_TOKEN}` },
      async ({ assets }) => {
        const asset = await assets.getWalletAssetsByIndex(0);
        const byAddress = new Map(
          asset.tokens.map((token) => [token.address.toLowerCase(), token]),
        );

        expect(byAddress.get(TOKEN.toLowerCase())!.error).toMatch(
          /balanceOf call failed/,
        );
        // The other token is unaffected.
        expect(byAddress.get(OTHER_TOKEN.toLowerCase())!.error).toBeNull();
        expect(byAddress.get(OTHER_TOKEN.toLowerCase())!.balanceRaw).toBe(
          parseUnits("9", 18).toString(),
        );
      },
      {
        balances: { [OTHER_TOKEN.toLowerCase()]: parseUnits("9", 18) },
        failing: { [TOKEN.toLowerCase()]: ["balanceOf"] },
      },
    );
  });

  it("returns no tokens when none are tracked", async () => {
    await withAssets({ TRACKED_TOKENS: undefined }, async ({ assets }) => {
      const asset = await assets.getWalletAssetsByIndex(0);
      expect(asset.tokens).toEqual([]);
    });
  });

  it("sums each asset across every wallet", async () => {
    await withAssets(
      { TRACKED_TOKENS: TOKEN },
      async ({ assets }) => {
        const totals = assets.totalsOf(await assets.getAllWalletAssets());

        expect(totals.nativeEth).toBe("6.0");
        expect(totals.tokens).toHaveLength(1);
        expect(totals.tokens[0]!.totalRaw).toBe(parseUnits("30", 18).toString());
        expect(totals.tokens[0]!.totalFormatted).toBe("30.0");
      },
      { balances: { [TOKEN.toLowerCase()]: parseUnits("10", 18) } },
    );
  });

  it("exposes assets over HTTP", async () => {
    await withConfig(
      { ...BASE_ENV, TRACKED_TOKENS: TOKEN },
      async () => {
        const { createApp } = await import("../src/api/app.js");
        const { initializeWallets } = await import(
          "../src/domain/balance/balance.service.js"
        );
        const { setProvider } = await import("../src/infra/rpc/provider.js");
        const database = await import("../src/infra/db/database.js");

        initializeWallets();
        setProvider(
          mockProvider({
            balances: { [TOKEN.toLowerCase()]: parseUnits("42", 18) },
            symbols: { [TOKEN.toLowerCase()]: "EVD" },
          }) as never,
        );

        const app = createApp();
        const server = await new Promise<import("node:http").Server>(
          (resolve) => {
            const started = app.listen(0, () => resolve(started));
          },
        );
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
          const all = await fetch(`${baseUrl}/assets`);
          const body = await all.json();

          expect(all.status).toBe(200);
          expect(body.walletCount).toBe(3);
          expect(body.trackedTokens).toEqual([TOKEN]);
          expect(body.wallets[0].tokens[0].balanceFormatted).toBe("42.0");

          const single = await fetch(`${baseUrl}/assets?walletIndex=1`);
          const singleBody = await single.json();
          expect(single.status).toBe(200);
          expect(singleBody.wallet.index).toBe(1);

          const bad = await fetch(`${baseUrl}/assets?walletIndex=99`);
          expect(bad.status).toBe(400);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          database.closeDatabase();
        }
      },
    );
  });
});
