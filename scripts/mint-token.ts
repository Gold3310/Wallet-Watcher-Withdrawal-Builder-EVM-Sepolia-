/**
 * Mints wWETH by locking ETH in a token contract.
 *
 *     npm run token:mint -- --contract 0x… --amount 0.01 --index 0
 *     npm run token:mint -- --contract 0x… --amount 0.01 --index 0 --broadcast
 *
 * Minting is depositing: one wei of ETH locked mints one wei of token, and
 * withdraw() later returns exactly that ETH. There is no owner-mint, which is
 * what keeps redemption honest — a supply conjured without backing is a supply
 * that cannot be honoured.
 *
 * Pointing this at someone else's WETH-style contract works, because deposit()
 * is ungated. It is also circular: you get back precisely the ETH you locked,
 * and nothing more. Locking ETH in the tracked contract does not entitle you to
 * any of the reserve already sitting there.
 */
import "dotenv/config";
import { formatEther, parseEther } from "ethers";
import { config } from "../src/config/index.js";
import { loadArtifact } from "../src/domain/token/artifact.js";
import { mintToken } from "../src/domain/token/deploy.js";
import { deriveWalletAtIndex, getDerivationPath } from "../src/domain/wallet/derivation.js";
import { assertReachable, getProvider } from "../src/infra/rpc/provider.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const flag = (name: string) => process.argv.includes(`--${name}`);

const contract = arg("contract") ?? process.env.WATCHER_TOKEN;
const rawAmount = arg("amount");
const index = Number(arg("index") ?? "0");

if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
  console.error(
    "--contract is required and must be an address. Pass it, or set " +
      "WATCHER_TOKEN in your .env.",
  );
  process.exit(1);
}

if (!rawAmount) {
  console.error("--amount is required, in ETH (for example: 0.01)");
  process.exit(1);
}

let amount: bigint;
try {
  amount = parseEther(rawAmount);
} catch {
  console.error(`--amount "${rawAmount}" is not a valid ETH amount`);
  process.exit(1);
}

if (amount <= 0n) {
  console.error("--amount must be greater than zero");
  process.exit(1);
}

if (!Number.isInteger(index) || index < 0 || index >= config.walletCount) {
  console.error(`--index must be between 0 and ${config.walletCount - 1}`);
  process.exit(1);
}

const broadcast = flag("broadcast");
const tracked = config.trackedContracts.some(
  (address) => address.toLowerCase() === contract.toLowerCase(),
);

try {
  await assertReachable();

  const artifact = loadArtifact();
  const signer = deriveWalletAtIndex(config.walletMnemonic, index).connect(
    getProvider(),
  );

  const plan = await mintToken(
    artifact,
    contract,
    signer as never,
    amount,
    broadcast,
  );

  console.log(`Mint${broadcast ? "" : " (planned)"}`);
  console.log(`  contract: ${plan.contract}`);
  console.log(`  from:     ${plan.from}  ${getDerivationPath(index)}`);
  console.log(`  value:    ${plan.value} wei (${formatEther(amount)} ETH)`);
  console.log(`  data:     ${plan.data}`);

  if (broadcast) {
    console.log(`  txHash:   ${plan.txHash ?? "unknown"}`);
  } else {
    console.log("");
    console.log("Nothing was sent. Add --broadcast to mint for real.");
  }

  if (tracked) {
    console.log("");
    console.log(
      "That is the tracked contract, not your own. deposit() is ungated so",
    );
    console.log(
      "this works — but you receive exactly the ETH you lock, and none of the",
    );
    console.log("reserve already held there. It is circular, not a way in.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
