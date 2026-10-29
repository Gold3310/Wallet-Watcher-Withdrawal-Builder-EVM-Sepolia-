/**
 * The compiled token, loaded from disk.
 *
 * The artifact is committed rather than gitignored so that deploying needs
 * nothing but this repository — no compiler install, no build step, no network.
 * `npm run token:compile` regenerates it, and a test asserts the committed
 * bytecode still matches the source, so it cannot drift unnoticed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Artifact {
  contractName: string;
  abi: readonly unknown[];
  bytecode: string;
}

export const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "artifacts",
  "WatcherWeth.json",
);

export function parseArtifact(raw: string): Artifact {
  const parsed = JSON.parse(raw) as Partial<Artifact>;

  if (
    typeof parsed.bytecode !== "string" ||
    !parsed.bytecode.startsWith("0x") ||
    parsed.bytecode.length < 4
  ) {
    throw new Error(
      "Artifact has no usable bytecode. Run `npm run token:compile`.",
    );
  }

  if (!Array.isArray(parsed.abi) || parsed.abi.length === 0) {
    throw new Error("Artifact has no ABI. Run `npm run token:compile`.");
  }

  return {
    contractName: parsed.contractName ?? "WatcherWeth",
    abi: parsed.abi,
    bytecode: parsed.bytecode,
  };
}

export function loadArtifact(): Artifact {
  try {
    return parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No compiled token at ${ARTIFACT_PATH}. Run \`npm run token:compile\` first.`,
      );
    }
    throw error;
  }
}
