import { describe, expect, it, vi } from "vitest";
import { TRACKED_CONTRACT_ABI } from "../src/domain/assets/abi.js";
import {
  OWNER_GATED_FUNCTIONS,
  analyseOwnership,
  readOwnership,
} from "../src/domain/assets/ownership.js";

const CONTRACT = "0xee1DC6BCF1Ee967a350e9aC6CaaAA236109002ea";
const DEPLOYER = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";
const SERVICE_OWNER = "0x2ddFBecA5B62f310A5F8edEFB4fC026A99B979CE";
const WALLET_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function analyse(overrides: Partial<Parameters<typeof analyseOwnership>[0]> = {}) {
  return analyseOwnership({
    contract: CONTRACT,
    owner: DEPLOYER,
    deployer: DEPLOYER,
    serviceOwner: SERVICE_OWNER,
    signableAddresses: [WALLET_0],
    abi: TRACKED_CONTRACT_ABI as readonly unknown[],
    ...overrides,
  });
}

describe("what the owner role is worth here", () => {
  it("lists the functions the owner may call", () => {
    const result = analyse();

    expect(result.ownerGatedFunctions).toEqual([
      "renounceOwnership",
      "setProposer",
      "transferOwnership",
    ]);
  });

  it("finds the functions that move value, and none are the owner's", () => {
    const result = analyse();
    const names = result.valueMovingFunctions.map((fn) => fn.name);

    // deposit is payable; withdraw/transfer/transferFrom move balances.
    expect(names).toContain("deposit");
    expect(names).toContain("withdraw");
    expect(names).toContain("transfer");

    expect(result.valueMovingFunctions.every((fn) => !fn.ownerGated)).toBe(true);
    expect(result.ownerCanMoveValue).toBe(false);
  });

  it("says plainly that holding the role would move nothing", () => {
    const verdict = analyse().verdict;

    expect(verdict).toMatch(/would not move a single wei/);
    // Alphabetical, as the analysis sorts them for stable output.
    expect(verdict).toMatch(/renounceOwnership, setProposer, transferOwnership/);
    expect(verdict).toMatch(/give you a role, not a claim/);
  });

  it("is a check, not a rubber stamp", () => {
    // With a hardcoded gated list this could only ever answer "no". Point it at
    // a contract where the owner genuinely controls value and it must say so.
    const result = analyse({
      abi: [
        "function owner() view returns (address)",
        "function withdraw(uint256 amount)",
        "function setProposer(address proposer, bool active)",
      ],
      ownerGatedFunctions: ["withdraw", "setProposer"],
    });

    expect(result.ownerCanMoveValue).toBe(true);
    expect(result.verdict).toMatch(/WOULD grant access to value/);
  });
});

describe("whether the role can be moved to you", () => {
  it("cannot, when the owner is not a wallet this service signs for", () => {
    const result = analyse();

    expect(result.serviceCanChangeOwner).toBe(false);
    expect(result.changeOwnerReason).toMatch(/onlyOwner/);
    expect(result.changeOwnerReason).toMatch(
      /not a wallet this service has keys for/,
    );
    expect(result.verdict).toMatch(/No amount of tooling changes that/);
  });

  it("could, if the owner were a wallet it holds", () => {
    const result = analyse({ owner: WALLET_0, signableAddresses: [WALLET_0] });

    expect(result.serviceCanChangeOwner).toBe(true);
    expect(result.changeOwnerReason).toMatch(/could sign transferOwnership/);
  });

  it("concludes nothing when the owner cannot be read", () => {
    const result = analyse({ owner: null });

    expect(result.changeOwnerReason).toMatch(/could not be read/);
    expect(result.verdict).toMatch(/nothing is concluded here/);
  });
});

describe("who holds the role", () => {
  it("notices the role has never moved from the deployer", () => {
    expect(analyse({ owner: DEPLOYER, deployer: DEPLOYER }).ownerIsDeployer).toBe(
      true,
    );
    expect(
      analyse({ owner: WALLET_0, deployer: DEPLOYER }).ownerIsDeployer,
    ).toBe(false);
  });

  it("compares against the configured service owner without case sensitivity", () => {
    const result = analyse({ owner: SERVICE_OWNER.toLowerCase() });
    expect(result.ownerIsServiceOwner).toBe(true);
  });

  it("reports null comparisons rather than a false answer", () => {
    expect(analyse({ owner: null }).ownerIsDeployer).toBeNull();
    expect(analyse({ serviceOwner: null }).ownerIsServiceOwner).toBeNull();
  });
});

describe("reading it live", () => {
  it("asks the contract for its owner and analyses the answer", async () => {
    const provider = {
      call: vi.fn().mockResolvedValue(
        // abi-encoded(address)
        `0x${DEPLOYER.slice(2).toLowerCase().padStart(64, "0")}`,
      ),
    };

    const result = await readOwnership(provider, CONTRACT, {
      abi: TRACKED_CONTRACT_ABI as readonly unknown[],
      deployer: DEPLOYER,
      serviceOwner: SERVICE_OWNER,
      signableAddresses: [WALLET_0],
    });

    expect(provider.call).toHaveBeenCalledWith({
      to: CONTRACT,
      data: expect.stringMatching(/^0x8da5cb5b/), // owner()
    });
    expect(result.owner?.toLowerCase()).toBe(DEPLOYER.toLowerCase());
    expect(result.ownerCanMoveValue).toBe(false);
  });

  it("records an unreadable owner instead of inventing one", async () => {
    const result = await readOwnership(
      { call: vi.fn().mockRejectedValue(new Error("reverted")) },
      CONTRACT,
      {
        abi: TRACKED_CONTRACT_ABI as readonly unknown[],
        deployer: DEPLOYER,
        serviceOwner: SERVICE_OWNER,
        signableAddresses: [],
      },
    );

    expect(result.owner).toBeNull();
    expect(result.verdict).toMatch(/nothing is concluded here/);
  });
});

describe("the documented gating list", () => {
  it("matches what the verified source says", () => {
    expect([...OWNER_GATED_FUNCTIONS].sort()).toEqual([
      "renounceOwnership",
      "setProposer",
      "transferOwnership",
    ]);
  });
});
