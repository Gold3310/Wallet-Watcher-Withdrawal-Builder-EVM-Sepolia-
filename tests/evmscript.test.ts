import { fileURLToPath } from "node:url";
import { Interface, ZeroHash, id } from "ethers";
import { describe, expect, it } from "vitest";
import {
  EvmScriptError,
  ScriptCall,
  encodeEvmScript,
  parseEvmScript,
} from "../src/domain/governance/evmscript.js";
import {
  candidateTypes,
  inferSignature,
  isLossyNumber,
  roleTable,
} from "../src/domain/governance/signatures.js";
import {
  DecodedCall,
  DecodedVerificationReport,
  loadDecodedCalls,
  parseDecodedCalls,
  verifyDecodedCalls,
} from "../src/domain/governance/verify-decoded.js";

// A real payload, unlike the synthetic event fixture: a third-party decoding of
// Lido DAO's Aragon Agent forward() call from the NEST buyback vote on Ethereum
// mainnet. Public governance data.
const FIXTURE = fileURLToPath(
  new URL("./fixtures/lido-nest-agent-forward.decoded.json", import.meta.url),
);

/** A fresh copy each time, so a test can mutate it freely. */
const payload = (): DecodedCall[] => loadDecodedCalls(FIXTURE);
const rawScriptOf = (calls: DecodedCall[]): string => calls[0]!.args[0] as string;

const AGENT = "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c";
const NOTIFIER = "0xbe05d12Fd10919F1881125006523452F6aFF791b";
const LOCATOR = "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb";
const STONKS_REGISTRY = "0x1a7cFA9EFB4D5BfFDE87B0FaEb1fC65d653868C0";
const REGISTRY = "0x8d8b35cA51e7808098afF4918C21Ce428c943F89";
const EXECUTOR = "0xFE5986E06210aC1eCC1aDCafc0cc7f8D63B3F977";
const STRANGER = "0x000000000000000000000000000000000000dEaD";

const abi = new Interface([
  "function forward(bytes)",
  "function grantRole(bytes32,address)",
  "function setLimits((uint256,address))",
]);

/** Rewrites the raw script inside the top-level call, leaving the decoded view alone. */
function withRawScript(
  calls: DecodedCall[],
  mutate: (raw: ScriptCall[]) => { to: string; calldata: string }[],
): DecodedCall[] {
  calls[0]!.args[0] = encodeEvmScript(mutate(parseEvmScript(rawScriptOf(calls))));
  return calls;
}

function at(report: DecodedVerificationReport, path: string) {
  const call = report.calls.find((entry) => entry.path === path);
  if (!call) {
    throw new Error(`No call at ${path}`);
  }
  return call;
}

const statuses = (report: DecodedVerificationReport) =>
  Object.fromEntries(report.calls.map((call) => [call.path, call.status]));

describe("parseEvmScript", () => {
  it("splits the Lido payload into its six calls, consuming every byte", () => {
    const script = rawScriptOf(payload());
    const calls = parseEvmScript(script);

    expect(calls.map((call) => call.to)).toEqual([
      NOTIFIER,
      NOTIFIER,
      LOCATOR,
      STONKS_REGISTRY,
      REGISTRY,
      REGISTRY,
    ]);
    expect(calls.map((call) => call.selector)).toEqual([
      "0xb8151420",
      "0xb8151420",
      "0x3ebdd0eb",
      "0x739b5384",
      "0x2f2ff15d",
      "0x2f2ff15d",
    ]);
    expect(calls.map((call) => (call.calldata.length - 2) / 2)).toEqual([68, 68, 36, 132, 68, 68]);
    expect(encodeEvmScript(calls)).toBe(script.toLowerCase());
  });

  it("accepts a script with no calls", () => {
    expect(parseEvmScript("0x00000001")).toEqual([]);
  });

  it("accepts a call with empty calldata, which has no selector", () => {
    const [call] = parseEvmScript(encodeEvmScript([{ to: STRANGER, calldata: "0x" }]));
    expect(call).toMatchObject({ to: STRANGER, calldata: "0x", selector: null });
  });

  it("rejects a spec ID other than CallsScript", () => {
    expect(() => parseEvmScript(`0x00000002${rawScriptOf(payload()).slice(10)}`)).toThrow(/spec ID 0x00000002/);
  });

  it("rejects a script shorter than its spec ID", () => {
    expect(() => parseEvmScript("0x0000")).toThrow(EvmScriptError);
  });

  it("rejects a dangling partial header, as aragonOS would", () => {
    expect(() => parseEvmScript(`${rawScriptOf(payload())}00`)).toThrow(/call header needs 24/);
  });

  it("rejects calldata that runs past the end of the script", () => {
    const truncated = rawScriptOf(payload()).slice(0, -2);
    expect(() => parseEvmScript(truncated)).toThrow(/declares 68 byte\(s\) of calldata, only 67 remain/);
  });

  it("rejects input that is not hex", () => {
    expect(() => parseEvmScript("0x0000001")).toThrow(/not valid 0x-prefixed hex/);
    expect(() => parseEvmScript("0xzz000001")).toThrow(EvmScriptError);
  });
});

describe("signature recovery", () => {
  it("recovers addObserver(address,uint8), which neither obvious guess matches", () => {
    expect(id("addObserver(address)").slice(0, 10)).not.toBe("0xb8151420");
    expect(id("addObserver(address,uint256)").slice(0, 10)).not.toBe("0xb8151420");

    const search = inferSignature("addObserver", ["0xd54c1c6413caac3477AC14b2a80D5398E3c32FfE", 0], "0xb8151420");
    expect(search.signature).toBe("addObserver(address,uint8)");
  });

  it("recovers every other signature in the payload", () => {
    const [top] = payload();
    expect(inferSignature("forward", top!.args, "0xd948d468").signature).toBe("forward(bytes)");

    const nested = top!.nestedCalls;
    const recovered = nested.map((call) => inferSignature(call.functionName, call.args, call.selector).signature);
    expect(recovered.slice(2)).toEqual([
      "proxy__upgradeTo(address)",
      "addRecipient(address,string)",
      "grantRole(bytes32,address)",
      "grantRole(bytes32,address)",
    ]);
  });

  it("finds nothing when no signature with that name hashes to the selector", () => {
    const search = inferSignature("removeObserver", [STRANGER, 0], "0xb8151420");
    expect(search.signature).toBeNull();
    expect(search.tried).toBeGreaterThan(0);
  });

  it("infers nothing from tuples, nulls or numbers that lost precision in JSON", () => {
    expect(candidateTypes({ limit: 1 })).toEqual([]);
    expect(candidateTypes(null)).toEqual([]);
    expect(candidateTypes(2 ** 60)).toEqual([]);
    expect(isLossyNumber(2 ** 60)).toBe(true);
    expect(isLossyNumber("1152921504606846976")).toBe(false);
  });

  it("refuses a search too large to run, rather than hanging", () => {
    expect(inferSignature("f", [1, 1, 1], "0x12345678", 10).tooLarge).toBe(true);
  });

  it("names roles by exact hash, matching the constants in Aragon's own source", () => {
    const roles = roleTable();
    // From aragon-apps Agent.sol, where these are hard-coded.
    expect(roles.get("0xcebf517aa4440d1d125e0355aae64401211d0848a23c02cc5d29a14822580ba4")).toBe(
      'keccak256("EXECUTE_ROLE")',
    );
    expect(roles.get("0xb421f7ad7646747f3051c50c0b8e2377839296cd4973e27f63821d73e390338f")).toBe(
      'keccak256("RUN_SCRIPT_ROLE")',
    );
    expect(roles.get(ZeroHash)).toMatch(/^DEFAULT_ADMIN_ROLE/);
    expect(roleTable(["CUSTOM_ROLE"]).get(id("CUSTOM_ROLE"))).toBe('keccak256("CUSTOM_ROLE")');
  });
});

describe("verifying the Lido payload", () => {
  it("verifies every call against the bytes", () => {
    const report = verifyDecodedCalls(payload());

    expect(report.fullyVerified).toBe(true);
    expect(report.summary).toEqual({ VERIFIED: 7, MISMATCH: 0, UNRESOLVED: 0 });
    expect(report.calls.map((call) => call.path)).toEqual(["1", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]);
    expect(at(report, "1.1").signature).toBe("addObserver(address,uint8)");
    expect(at(report, "1.1").checks).toMatchObject({
      target: true,
      selector: true,
      functionName: true,
      arguments: true,
      canonicalEncoding: true,
    });
  });

  it("names the roles the two grantRole calls grant", () => {
    const report = verifyDecodedCalls(payload());
    expect(at(report, "1.5").annotations).toEqual(['args[0] is keccak256("ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE")']);
    expect(at(report, "1.6").annotations).toEqual(['args[0] is keccak256("REMOVE_RECIPIENT_FROM_ALLOWED_LIST_ROLE")']);
  });

  it("says what it could not check", () => {
    const report = verifyDecodedCalls(payload());
    expect(report.notes.join(" ")).toMatch(/zero ETH/);
    expect(report.notChecked.join(" ")).toMatch(/Which chain/);
    expect(report.notChecked.join(" ")).toMatch(/AGENT_CAN_NOT_FORWARD/);
  });
});

describe("catching a decoded view that does not match the bytes", () => {
  it("catches a changed argument", () => {
    const calls = payload();
    calls[0]!.nestedCalls[1]!.args[1] = 2;

    const report = verifyDecodedCalls(calls);
    expect(report.fullyVerified).toBe(false);
    expect(at(report, "1.2").status).toBe("MISMATCH");
    expect(at(report, "1.2").notes.join(" ")).toMatch(/args\[1\]: claimed 2, encoded "1"/);
    expect(at(report, "1.1").status).toBe("VERIFIED");
  });

  it("catches the wrong target", () => {
    const calls = payload();
    calls[0]!.nestedCalls[2]!.contractAddress = STRANGER;

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1.3").checks.target).toBe(false);
    expect(at(report, "1.3").to).toBe(LOCATOR);
  });

  it("catches a selector that is not the one in the bytes", () => {
    const calls = payload();
    calls[0]!.nestedCalls[0]!.selector = "0xfb8ec972";

    expect(at(verifyDecodedCalls(calls), "1.1").checks.selector).toBe(false);
  });

  it("catches a changed byte in the script itself", () => {
    const calls = withRawScript(payload(), (raw) =>
      raw.map((call) =>
        call.index === 3
          ? { to: call.to, calldata: call.calldata.replace("aa568141c051f2d1132b110f8391f18d48e8d889", STRANGER.slice(2).toLowerCase()) }
          : call,
      ),
    );

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1.4").status).toBe("MISMATCH");
    expect(at(report, "1.4").notes.join(" ")).toMatch(/args\[0\]/);
    expect(at(report, "1.3").status).toBe("VERIFIED");
  });

  it("catches a call hidden from the decoded view, and shows what it is", () => {
    const hidden = abi.encodeFunctionData("grantRole", [ZeroHash, STRANGER]);
    const calls = withRawScript(payload(), (raw) => [...raw, { to: REGISTRY, calldata: hidden }]);

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1").checks.nestedCallCount).toBe(false);
    expect(at(report, "1.7")).toMatchObject({ status: "MISMATCH", to: REGISTRY, selector: "0x2f2ff15d" });
    expect(at(report, "1.7").notes.join(" ")).toMatch(/missing from the decoded view/);
  });

  it("catches a call the decoded view invents", () => {
    const calls = payload();
    calls[0]!.nestedCalls.push(structuredClone(calls[0]!.nestedCalls[5]!));

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1.7").status).toBe("MISMATCH");
    expect(at(report, "1.7").notes.join(" ")).toMatch(/absent from the raw script/);
  });

  it("catches reordered calls: order is what executes", () => {
    const calls = payload();
    const nested = calls[0]!.nestedCalls;
    [nested[2], nested[3]] = [nested[3]!, nested[2]!];

    expect(statuses(verifyDecodedCalls(calls))).toMatchObject({ "1.3": "MISMATCH", "1.4": "MISMATCH", "1.5": "VERIFIED" });
  });

  it("catches nested calls dropped from the view entirely", () => {
    const calls = payload();
    calls[0]!.nestedCalls = [];

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1").checks.nestedCallsListed).toBe(false);
    expect(report.summary.MISMATCH).toBe(7);
  });

  it("catches dirty padding that a decoder silently masks away", () => {
    // 0x0101 in a uint8 slot: ethers decodes it as 1, exactly what the view claims.
    const calls = withRawScript(payload(), (raw) =>
      raw.map((call) =>
        call.index === 1 ? { to: call.to, calldata: `${call.calldata.slice(0, -4)}0101` } : call,
      ),
    );

    const check = at(verifyDecodedCalls(calls), "1.2");
    expect(check.checks.arguments).toBe(true);
    expect(check.checks.canonicalEncoding).toBe(false);
    expect(check.status).toBe("MISMATCH");
  });

  it("catches trailing bytes the decoded arguments do not show", () => {
    const calls = withRawScript(payload(), (raw) =>
      raw.map((call) => (call.index === 2 ? { to: call.to, calldata: `${call.calldata}deadbeef` } : call)),
    );

    const check = at(verifyDecodedCalls(calls), "1.3");
    expect(check.checks.canonicalEncoding).toBe(false);
    expect(check.notes.join(" ")).toMatch(/not canonically encoded/);
  });

  it("does not accept a label that does not hash to the selector", () => {
    const calls = payload();
    calls[0]!.nestedCalls[0]!.functionName = "removeObserver";

    const inferred = at(verifyDecodedCalls(calls), "1.1");
    expect(inferred.status).toBe("UNRESOLVED");
    expect(inferred.notes.join(" ")).toMatch(/No signature named removeObserver/);

    const explicit = at(verifyDecodedCalls(calls, { signatures: ["addObserver(address,uint8)"] }), "1.1");
    expect(explicit.status).toBe("MISMATCH");
    expect(explicit.checks.functionName).toBe(false);
  });

  it("checks a signature the decoder states outright", () => {
    const wrong = payload();
    wrong[0]!.nestedCalls[0]!.functionName = "addObserver(address,uint256)";
    expect(at(verifyDecodedCalls(wrong), "1.1").notes.join(" ")).toMatch(/hashes to 0xb25db1da, not 0xb8151420/);
    expect(at(verifyDecodedCalls(wrong), "1.1").status).toBe("MISMATCH");

    const right = payload();
    right[0]!.nestedCalls[0]!.functionName = "addObserver(address,uint8)";
    expect(at(verifyDecodedCalls(right), "1.1")).toMatchObject({ status: "VERIFIED", signatureSource: "stated" });
  });

  it("catches an address whose EIP-55 checksum is wrong", () => {
    const calls = payload();
    // Flip the case of one letter in a checksummed address.
    calls[0]!.nestedCalls[2]!.args[0] = "0xf2Ffb952e129a63F0614Ff87126E1d4a494A2313";

    const check = at(verifyDecodedCalls(calls), "1.3");
    expect(check.status).toBe("MISMATCH");
    expect(check.notes.join(" ")).toMatch(/invalid EIP-55 checksum/);
  });
});

describe("beyond the fixture", () => {
  const inner = encodeEvmScript([
    { to: REGISTRY, calldata: abi.encodeFunctionData("grantRole", [id("ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE"), EXECUTOR]) },
  ]);
  const outer = encodeEvmScript([{ to: AGENT, calldata: abi.encodeFunctionData("forward", [inner]) }]);

  const nestedTwice = (): DecodedCall[] => [
    {
      contractAddress: STRANGER,
      functionName: "forward",
      selector: "0xd948d468",
      args: [outer],
      nestedCalls: [
        {
          contractAddress: AGENT,
          functionName: "forward",
          selector: "0xd948d468",
          args: [inner],
          nestedCalls: [
            {
              contractAddress: REGISTRY,
              functionName: "grantRole",
              selector: "0x2f2ff15d",
              args: [id("ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE"), EXECUTOR],
              nestedCalls: [],
            },
          ],
        },
      ],
    },
  ];

  it("follows scripts nested inside scripts", () => {
    const report = verifyDecodedCalls(nestedTwice());
    expect(statuses(report)).toEqual({ "1": "VERIFIED", "1.1": "VERIFIED", "1.1.1": "VERIFIED" });
    expect(at(report, "1.1.1").annotations[0]).toMatch(/ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE/);
  });

  it("reads deeper calls from the bytes, not from the decoder's copy of them", () => {
    const calls = nestedTwice();
    const middle = calls[0]!.nestedCalls[0]!;
    // The decoder shows a different inner script, and children matching it.
    middle.args[0] = encodeEvmScript([
      { to: REGISTRY, calldata: abi.encodeFunctionData("grantRole", [id("ADD_RECIPIENT_TO_ALLOWED_LIST_ROLE"), STRANGER]) },
    ]);
    middle.nestedCalls[0]!.args[1] = STRANGER;

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1.1").checks.arguments).toBe(false);
    expect(at(report, "1.1.1").status).toBe("MISMATCH");
  });

  it("leaves deeper calls unresolved when their parent cannot be decoded", () => {
    const calls = nestedTwice();
    calls[0]!.nestedCalls[0]!.functionName = "execute";

    const report = verifyDecodedCalls(calls);
    expect(statuses(report)).toEqual({ "1": "VERIFIED", "1.1": "UNRESOLVED", "1.1.1": "UNRESOLVED" });
    expect(report.fullyVerified).toBe(false);
  });

  it("takes an explicit signature for arguments inference cannot express", () => {
    const limits = abi.encodeFunctionData("setLimits", [[5n, EXECUTOR]]);
    const calls = (): DecodedCall[] => [
      {
        contractAddress: AGENT,
        functionName: "forward",
        selector: "0xd948d468",
        args: [encodeEvmScript([{ to: REGISTRY, calldata: limits }])],
        nestedCalls: [
          {
            contractAddress: REGISTRY,
            functionName: "setLimits",
            selector: limits.slice(0, 10),
            args: [[5, EXECUTOR]],
            nestedCalls: [],
          },
        ],
      },
    ];

    expect(at(verifyDecodedCalls(calls()), "1.1").status).toBe("UNRESOLVED");

    const explicit = at(verifyDecodedCalls(calls(), { signatures: ["setLimits((uint256,address))"] }), "1.1");
    expect(explicit).toMatchObject({ status: "VERIFIED", signatureSource: "explicit" });
  });

  it("finds calls hidden in a second script argument behind an empty first one", () => {
    const calls: DecodedCall[] = [
      {
        contractAddress: AGENT,
        functionName: "run",
        selector: id("run(bytes,bytes)").slice(0, 10),
        args: ["0x00000001", inner],
        nestedCalls: [],
      },
    ];

    const report = verifyDecodedCalls(calls);
    expect(at(report, "1").checks.nestedCallsListed).toBe(false);
    expect(at(report, "1").notes.join(" ")).toMatch(/args\[1\] is a well-formed EVMScript carrying 1 call/);
    expect(at(report, "1.1")).toMatchObject({ status: "MISMATCH", to: REGISTRY });
  });

  it("rejects an explicit signature that is not one", () => {
    expect(() => verifyDecodedCalls(payload(), { signatures: ["not a signature"] })).toThrow(/Not a function signature/);
  });
});

describe("loading decoded calls", () => {
  it("accepts one call or an array of them", () => {
    const [single] = payload();
    expect(parseDecodedCalls(single)).toHaveLength(1);
    expect(parseDecodedCalls([single, single])).toHaveLength(2);
    expect(payload()[0]!.nestedCalls).toHaveLength(6);
  });

  it("rejects input missing what verification needs", () => {
    expect(() => parseDecodedCalls([])).toThrow(/No calls found/);
    expect(() => parseDecodedCalls({ contractAddress: AGENT, functionName: "forward", args: [] })).toThrow(/selector/);
    expect(() =>
      parseDecodedCalls({ contractAddress: AGENT, functionName: "forward", selector: "0xd948d468", args: [], nestedCalls: {} }),
    ).toThrow(/nestedCalls must be an array/);
  });
});
