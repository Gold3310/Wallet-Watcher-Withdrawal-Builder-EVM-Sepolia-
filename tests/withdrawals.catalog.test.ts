import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import {
  buildWithdrawalCatalog,
  contractCapabilities,
  findWithdrawalCapability,
} from "../src/domain/assets/withdrawals.catalog.js";

const CUSTOM_ABI = [
  "function owner() view returns (address)",
  "function withdraw(uint256 amount)",
  "function mysteryHook(bytes data)",
  "function totalSupply() view returns (uint256)",
];

describe("the withdrawal catalogue", () => {
  it("includes withdraw, the only route to the reserve", () => {
    const withdraw = findWithdrawalCapability("contract:withdraw");
    expect(withdraw).toBeDefined();
    expect(withdraw?.kind).toBe("redemption");
    expect(withdraw?.selector).toBe("0x2e1a7d4d");
    expect(withdraw?.signature).toBe("withdraw(uint256 wad)");
    expect(withdraw?.executableHere).toBe(true);
    expect(withdraw?.blocker).toBeUndefined();
  });

  it("blocks the administrative functions and says why", () => {
    const catalog = buildWithdrawalCatalog();

    for (const name of [
      "contract:setProposer",
      "contract:transferOwnership",
      "contract:renounceOwnership",
    ]) {
      const cap = catalog.capabilities.find((entry) => entry.id === name);
      expect(cap?.executableHere).toBe(false);
      expect(cap?.blocker ?? "").toMatch(/onlyOwner/);
    }

    expect(catalog.blocked).toHaveLength(3);
  });

  it("lists only what can change state", () => {
    const names = contractCapabilities().map((cap) => cap.name);

    expect(names).toContain("withdraw");
    expect(names).toContain("transfer");
    // Read-only views must not be presented as ways to move value.
    expect(names).not.toContain("totalSupply");
    expect(names).not.toContain("balanceOf");
    expect(names).not.toContain("owner");
    expect(names).not.toContain("allowance");
  });

  it("gives every entry the fields that make it usable", () => {
    for (const cap of buildWithdrawalCatalog().capabilities) {
      expect(cap.id).toBeTruthy();
      expect(cap.signature).toBeTruthy();
      expect(cap.summary).toBeTruthy();
      expect(cap.requirement).toBeTruthy();
      expect(cap.invoke).toBeTruthy();
    }
  });

  it("does not claim every contract function is an unwrap", () => {
    // An earlier version printed the same unwrap command for every entry.
    const transfer = findWithdrawalCapability("contract:transfer");
    expect(transfer?.invoke).not.toMatch(/\/assets\/unwrap/);
    expect(transfer?.invoke).toMatch(/0xa9059cbb/);
  });

  it("says what it can and cannot run", () => {
    const catalog = buildWithdrawalCatalog();

    expect(catalog.available).toContain("contract:withdraw");
    expect(catalog.available).not.toContain("contract:transferOwnership");
    expect(catalog.verdict).toMatch(/withdraw is the only route/);
    expect(catalog.verdict).toMatch(/holding an ABT balance/);
  });
});

describe("against an unfamiliar contract", () => {
  it("shows what it does not recognise instead of hiding it", () => {
    const catalog = buildWithdrawalCatalog(CUSTOM_ABI);

    expect(catalog.unclassified).toContain("contract:mysteryHook");
    expect(
      catalog.capabilities.find((cap) => cap.id === "contract:mysteryHook")
        ?.kind,
    ).toBe("unclassified");
    expect(catalog.verdict).toMatch(/have not been classified/);
  });

  it("admits it when nothing can be withdrawn", () => {
    // Classified but administrative, so nothing is unclassified to warn about
    // and no redemption exists.
    const catalog = buildWithdrawalCatalog([
      "function setProposer(address proposer, bool enabled)",
    ]);

    expect(catalog.verdict).toMatch(/No value-moving function was found/);
  });

  it("warns about the unknown before concluding anything", () => {
    // An unrecognised function outranks the "nothing found" verdict: telling
    // you something is unexamined beats telling you it is absent.
    const catalog = buildWithdrawalCatalog(["function pause()"]);

    expect(catalog.unclassified).toContain("contract:pause");
    expect(catalog.verdict).toMatch(/have not been classified/);
  });

  it("still omits views from a custom ABI", () => {
    const names = contractCapabilities(CUSTOM_ABI).map((cap) => cap.name);
    expect(names).not.toContain("totalSupply");
  });
});

describe("finding one capability", () => {
  it("returns it by id", () => {
    expect(findWithdrawalCapability("api:assets:unwrap")?.layer).toBe("api");
  });

  it("returns undefined rather than guessing", () => {
    expect(findWithdrawalCapability("contract:doesNotExist")).toBeUndefined();
  });
});

describe("GET /assets/withdrawals", () => {
  let baseUrl: string;
  let server: Awaited<ReturnType<ReturnType<typeof createApp>["listen"]>>;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the whole catalogue", async () => {
    const response = await fetch(`${baseUrl}/assets/withdrawals`);
    const body = (await response.json()) as {
      capabilities: { id: string }[];
      verdict: string;
    };

    expect(response.status).toBe(200);
    expect(body.capabilities.length).toBeGreaterThan(0);
    expect(body.verdict).toBeTruthy();
  });

  it("serves a single capability", async () => {
    const response = await fetch(
      `${baseUrl}/assets/withdrawals/contract:withdraw`,
    );
    const body = (await response.json()) as { id: string; kind: string };

    expect(response.status).toBe(200);
    expect(body.id).toBe("contract:withdraw");
    expect(body.kind).toBe("redemption");
  });

  it("404s an unknown id instead of returning something similar", async () => {
    const response = await fetch(`${baseUrl}/assets/withdrawals/nope`);
    expect(response.status).toBe(404);
  });
});
