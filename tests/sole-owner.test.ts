import type { AddressInfo } from "node:net";
import { parseEther } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { withConfig } from "./helpers/withConfig.js";

/** The one address allowed to use the service. */
const OWNER = "0x2ddfbeca5b62f310a5f8edefb4fc026a99b979ce";
const OWNER_CHECKSUMMED = "0x2ddFBecA5B62f310A5F8edEFB4fC026A99B979CE";
/** The contract this service tracks. */
const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
/** Anybody else. */
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const SECRET = "test-owner-secret";

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
  OWNER_ADDRESS: undefined,
  WITHDRAWAL_ALLOWLIST: undefined,
  TRACKED_CONTRACT: undefined,
  TRACKED_TOKENS: undefined,
};

interface Harness {
  baseUrl: string;
}

async function withServer(
  env: Record<string, string | undefined>,
  fn: (harness: Harness) => Promise<void>,
): Promise<void> {
  await withConfig({ ...BASE_ENV, ...env }, async () => {
    const { createApp } = await import("../src/api/app.js");
    const { initializeWallets } = await import(
      "../src/domain/balance/balance.service.js"
    );
    const { setProvider } = await import("../src/infra/rpc/provider.js");
    const database = await import("../src/infra/db/database.js");

    setProvider({
      getBalance: vi.fn().mockResolvedValue(parseEther("1000")),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      broadcastTransaction: vi.fn(),
    } as never);
    initializeWallets();

    const app = createApp();
    const server: import("node:http").Server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await fn({ baseUrl });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.closeDatabase();
    }
  });
}

describe("sole owner configuration", () => {
  it("accepts exactly one owner matching OWNER_ADDRESS", async () => {
    await withConfig(
      {
        ...BASE_ENV,
        OWNER_ADDRESS: OWNER,
        API_TOKENS: `${OWNER}:${SECRET}`,
      },
      async (config) => {
        expect(config.ownerAddress).toBe(OWNER_CHECKSUMMED);
        expect([...config.apiTokens.keys()]).toEqual([OWNER_CHECKSUMMED]);
      },
    );
  });

  it("normalises a lowercase owner address to checksum form", async () => {
    await withConfig(
      {
        ...BASE_ENV,
        OWNER_ADDRESS: OWNER.toLowerCase(),
        API_TOKENS: `${OWNER_CHECKSUMMED}:${SECRET}`,
      },
      async (config) => {
        expect(config.ownerAddress).toBe(OWNER_CHECKSUMMED);
      },
    );
  });

  it("refuses to start when the owner has no credential", async () => {
    await expect(
      withConfig(
        { ...BASE_ENV, OWNER_ADDRESS: OWNER, API_TOKENS: undefined },
        async () => {},
      ),
    ).rejects.toThrow(/API_TOKENS is empty/);
  });

  it("refuses to start when the credential belongs to somebody else", async () => {
    await expect(
      withConfig(
        {
          ...BASE_ENV,
          OWNER_ADDRESS: OWNER,
          API_TOKENS: `${OTHER}:${SECRET}`,
        },
        async () => {},
      ),
    ).rejects.toThrow(/does not match OWNER_ADDRESS/);
  });

  it("refuses to start when a second owner is added alongside the right one", async () => {
    await expect(
      withConfig(
        {
          ...BASE_ENV,
          OWNER_ADDRESS: OWNER,
          API_TOKENS: `${OWNER}:${SECRET},${OTHER}:another-secret`,
        },
        async () => {},
      ),
    ).rejects.toThrow(/permits exactly one owner/);
  });

  it("rejects an OWNER_ADDRESS that is not an address", async () => {
    await expect(
      withConfig({ ...BASE_ENV, OWNER_ADDRESS: "not-an-address" }, async () => {}),
    ).rejects.toThrow(/must be a valid Ethereum address/);
  });

  it("leaves owner mode off when OWNER_ADDRESS is unset", async () => {
    await withConfig(
      { ...BASE_ENV, API_TOKENS: `${OTHER}:${SECRET}` },
      async (config) => {
        expect(config.ownerAddress).toBeNull();
      },
    );
  });
});

describe("sole owner over HTTP", () => {
  it("admits the owner and rejects everyone else", async () => {
    await withServer(
      { OWNER_ADDRESS: OWNER, API_TOKENS: `${OWNER}:${SECRET}` },
      async ({ baseUrl }) => {
        const anonymous = await fetch(`${baseUrl}/wallets`);
        expect(anonymous.status).toBe(401);

        const wrongSecret = await fetch(`${baseUrl}/wallets`, {
          headers: { authorization: "Bearer not-the-secret" },
        });
        expect(wrongSecret.status).toBe(401);

        const owner = await fetch(`${baseUrl}/wallets`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(owner.status).toBe(200);
      },
    );
  });

  it("leaves /health open for probes", async () => {
    await withServer(
      { OWNER_ADDRESS: OWNER, API_TOKENS: `${OWNER}:${SECRET}` },
      async ({ baseUrl }) => {
        const health = await fetch(`${baseUrl}/health`);
        expect(health.status).toBe(200);
      },
    );
  });

  it("blocks the owner from withdrawing to a destination outside the allowlist", async () => {
    await withServer(
      {
        OWNER_ADDRESS: OWNER,
        API_TOKENS: `${OWNER}:${SECRET}`,
        WITHDRAWAL_ALLOWLIST: OWNER,
      },
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/withdrawals`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({
            fromWalletIndex: 0,
            toAddress: OTHER,
            amountWei: "1000000000000000",
            broadcast: false,
          }),
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatch(/allowlist/i);
      },
    );
  });
});

describe("sole owner gate", () => {
  it("rejects a non-owner actor even once authentication has passed", async () => {
    await withConfig(
      {
        ...BASE_ENV,
        OWNER_ADDRESS: OWNER,
        API_TOKENS: `${OWNER}:${SECRET}`,
      },
      async () => {
        const { authorizeOwner } = await import(
          "../src/api/middleware/auth.js"
        );

        const denied = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        };
        const blockedNext = vi.fn();
        authorizeOwner(
          { actor: { id: OTHER } } as never,
          denied as never,
          blockedNext,
        );
        expect(denied.status).toHaveBeenCalledWith(403);
        expect(blockedNext).not.toHaveBeenCalled();

        const allowed = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        };
        const allowedNext = vi.fn();
        authorizeOwner(
          { actor: { id: OWNER_CHECKSUMMED } } as never,
          allowed as never,
          allowedNext,
        );
        expect(allowed.status).not.toHaveBeenCalled();
        expect(allowedNext).toHaveBeenCalled();
      },
    );
  });
});

describe("tracked contract configuration", () => {
  it("tracks the configured contract", async () => {
    await withConfig(
      { ...BASE_ENV, TRACKED_CONTRACT: CONTRACT },
      async (config) => {
        expect(config.trackedContracts).toEqual([CONTRACT]);
      },
    );
  });

  it("tracks nothing when unset", async () => {
    await withConfig({ ...BASE_ENV }, async (config) => {
      expect(config.trackedContracts).toEqual([]);
    });
  });

  it("deduplicates a repeated contract", async () => {
    await withConfig(
      { ...BASE_ENV, TRACKED_CONTRACT: `${CONTRACT},${CONTRACT}` },
      async (config) => {
        expect(config.trackedContracts).toEqual([CONTRACT]);
      },
    );
  });

  it("still accepts the deprecated TRACKED_TOKENS name, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await withConfig(
        { ...BASE_ENV, TRACKED_TOKENS: CONTRACT },
        async (config) => {
          expect(config.trackedContracts).toEqual([CONTRACT]);
        },
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("prefers TRACKED_CONTRACT over the deprecated alias", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await withConfig(
        {
          ...BASE_ENV,
          TRACKED_CONTRACT: CONTRACT,
          TRACKED_TOKENS: OTHER,
        },
        async (config) => {
          expect(config.trackedContracts).toEqual([CONTRACT]);
        },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a contract that is not an address", async () => {
    await expect(
      withConfig(
        { ...BASE_ENV, TRACKED_CONTRACT: "0xdeadbeef" },
        async () => {},
      ),
    ).rejects.toThrow(/Invalid address in TRACKED_CONTRACT/);
  });
});
