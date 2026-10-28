/**
 * Deploys WatcherWeth from a wallet derived from your mnemonic.
 *
 *     npm run token:deploy -- --index 0               # plan only, sends nothing
 *     npm run token:deploy -- --index 0 --broadcast   # actually deploy
 *
 * The deployer becomes the contract's owner, which is the closest honest
 * version of "derive a wallet and use it as the owner": a role you hold, on a
 * contract you control. It is not the tracked contract's owner and cannot be
 * made one — `transferOwnership` there is `onlyOwner` and needs Risk Labs' key.
 *
 * Planning and broadcasting are separate calls on purpose. A deploy cannot be
 * undone, so you see the predicted address and the gas estimate first. On
 * mainnet this additionally requires MAINNET_ENABLED=true.
 *
 * This token is yours. It is not Across' Bond Token, it is not affiliated with
 * Across or Risk Labs, and it must never be presented as either.
 */
import "dotenv/config";
import { config } from "../src/config/index.js";
import { loadArtifact } from "../src/domain/token/artifact.js";
import { deployToken } from "../src/domain/token/deploy.js";
import { deriveWalletAtIndex, getDerivationPath } from "../src/domain/wallet/derivation.js";
import { assertReachable, getProvider } from "../src/infra/rpc/provider.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const flag = (name: string) => process.argv.includes(`--${name}`);

const index = Number(arg("index") ?? "0");

if (!Number.isInteger(index) || index < 0) {
  console.error("--index must be a non-negative integer");
  process.exit(1);
}

if (index >= config.walletCount) {
  console.error(
    `Wallet index ${index} is outside WALLET_COUNT=${config.walletCount}. ` +
      `Raise WALLET_COUNT, or pick an index below it.`,
  );
  process.exit(1);
}

const broadcast = flag("broadcast");

try {
  await assertReachable();

  const artifact = loadArtifact();
  const signer = deriveWalletAtIndex(config.walletMnemonic, index).connect(
    getProvider(),
  );

  const plan = await deployToken(signer as never, artifact, broadcast);

  console.log(`${artifact.contractName} deploy${broadcast ? "" : " (planned)"}`);
  console.log(`  network:   ${config.network} (chainId ${config.chainId})`);
  console.log(`  deployer:  ${plan.from}  ${getDerivationPath(index)}`);
  console.log(
    `  predicted: ${
      plan.predictedAddress ?? "unknown — could not read the deployer nonce"
    }`,
  );
  console.log(
    `  gas:       ${plan.gasEstimate ?? "not estimable — fund the deployer first"}`,
  );
  console.log(`  bytecode:  ${(artifact.bytecode.length - 2) / 2} bytes`);

  if (broadcast) {
    console.log(`  txHash:    ${plan.txHash ?? "unknown"}`);
    console.log(`  address:   ${plan.address ?? "pending"}`);
    console.log("");
    console.log("Next: point the service at it and mint against it.");
    console.log(`  TRACKED_CONTRACT=${plan.address ?? "<address>"}`);
    console.log(
      `  npm run token:mint -- --index ${index} --amount 0.01 --contract ${plan.address ?? "<address>"} --broadcast`,
    );
  } else {
    console.log("");
    console.log("Nothing was sent. Add --broadcast to deploy for real.");
    console.log(
      "Fund the deployer first (Sepolia faucet) — an unfunded account cannot pay gas.",
    );
  }

  console.log("");
  console.log(
    "Reminder: this is your own token. It is not Across' Bond Token and must",
  );
  console.log("never be presented as it.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
