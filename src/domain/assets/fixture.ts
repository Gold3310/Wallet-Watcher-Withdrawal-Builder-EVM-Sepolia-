/**
 * A provider built from recorded data instead of a network.
 *
 * Two reasons this exists.
 *
 * First, it makes the report demonstrable. The confirmation script needs an RPC
 * endpoint, and this sandbox has no path to one — so without a fixture there is
 * no way to show what the output looks like, or to check that the render path
 * works at all, until someone runs it against a live chain.
 *
 * Second, it exercises the same code path as a real run. The report is built by
 * `readHolderReport` here exactly as it would be against a node, so what is
 * demonstrated is the real thing rather than a mock of it.
 *
 * What it must never be mistaken for: a live read. Every rendering of fixture
 * data is labelled as such, because a report that looks real and is not is
 * worse than no report — it invites exactly the kind of confident wrong
 * conclusion this project keeps having to walk back.
 */
import { trackedContractInterface } from "./abi.js";

export interface HolderFixture {
  /** Where the numbers came from, shown alongside any output. */
  source: string;
  recordedAt: string;
  contract: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  ethReserve: string;
  /** Lowercase holder address -> raw token balance. */
  balances: Record<string, string>;
  /** Lowercase holder address -> raw ETH. Absent entries read as null. */
  native: Record<string, string>;
}

export function parseFixture(raw: string): HolderFixture {
  const parsed = JSON.parse(raw) as Partial<HolderFixture>;

  if (typeof parsed.contract !== "string") {
    throw new Error("Fixture is missing `contract`");
  }
  if (typeof parsed.totalSupply !== "string") {
    throw new Error("Fixture is missing `totalSupply`");
  }

  return {
    source: parsed.source ?? "unrecorded source",
    recordedAt: parsed.recordedAt ?? "unknown date",
    contract: parsed.contract,
    symbol: parsed.symbol ?? "?",
    decimals: parsed.decimals ?? 18,
    totalSupply: parsed.totalSupply,
    ethReserve: parsed.ethReserve ?? "0",
    balances: parsed.balances ?? {},
    native: parsed.native ?? {},
  };
}

const enc = (name: string, values: unknown[]) =>
  trackedContractInterface.encodeFunctionResult(name, values as never[]);

/**
 * Answers only what `readHolderReport` asks. Anything else throws rather than
 * returning a plausible zero, so a gap shows up as a failure instead of
 * quietly reading as "this address holds nothing".
 */
export function fixtureProvider(fixture: HolderFixture) {
  return {
    getBalance: async (address: string): Promise<bigint> => {
      const key = address.toLowerCase();

      if (key === fixture.contract.toLowerCase()) {
        return BigInt(fixture.ethReserve);
      }

      const native = fixture.native[key];

      // Absent means unrecorded, which is NOT the same as zero. Returning 0n
      // would mark a holder "gas-blocked" — holding a claim with no ETH for
      // gas — on the strength of a gap in the snapshot. That is precisely the
      // confident wrong conclusion a report must not manufacture. Throwing
      // lets the caller record it as unknown instead.
      if (native === undefined) {
        throw new Error(
          `Fixture records no ETH for ${address}; unknown, not zero`,
        );
      }

      return BigInt(native);
    },

    call: async ({ to, data }: { to: string; data: string }): Promise<string> => {
      if (to.toLowerCase() !== fixture.contract.toLowerCase()) {
        throw new Error(`Fixture only knows ${fixture.contract}, not ${to}`);
      }

      const fragment = trackedContractInterface.getFunction(data.slice(0, 10));

      switch (fragment?.name) {
        case "balanceOf": {
          const [holder] = trackedContractInterface.decodeFunctionData(
            "balanceOf",
            data,
          ) as unknown as [string];
          const raw = fixture.balances[holder.toLowerCase()];
          return enc("balanceOf", [raw === undefined ? 0n : BigInt(raw)]);
        }
        case "decimals":
          return enc("decimals", [fixture.decimals]);
        case "symbol":
          return enc("symbol", [fixture.symbol]);
        case "totalSupply":
          return enc("totalSupply", [BigInt(fixture.totalSupply)]);
        default:
          throw new Error(
            `Fixture cannot answer ${fragment?.name ?? "unknown call"}`,
          );
      }
    },
  };
}
