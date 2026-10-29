import { vi } from "vitest";

type Config = typeof import("../../src/config/index.js")["config"];

/**
 * Re-imports the config (and anything the callback imports) under a different
 * environment. Config is evaluated once at module load, so picking up new
 * values needs a module reset.
 */
export async function withConfig<T>(
  env: Record<string, string | undefined>,
  fn: (config: Config) => Promise<T> | T,
): Promise<T> {
  const original = { ...process.env };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();

  try {
    const { config } = await import("../../src/config/index.js");
    return await fn(config);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(original)) {
      process.env[key] = value as string;
    }
    vi.resetModules();
  }
}
