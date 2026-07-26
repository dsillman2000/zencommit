/**
 * Configuration persistence for zencommit.
 *
 * Reads and writes a JSON config file at {@link configPath}
 * (default: ``~/.config/zencommit/config.json``, respecting ``XDG_CONFIG_HOME``).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/** Parent directory for configuration (respects ``XDG_CONFIG_HOME``). */
const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

/** Directory where the zencommit config file lives. */
const configDirPath = join(configDir, "zencommit");

/** Full path to the zencommit config JSON file. */
const configPath = join(configDirPath, "config.json");

/**
 * User configuration model.
 *
 * Supports arbitrary string keys via the index signature so users can
 * store any future config properties.
 */
export interface Config {
  /** OpenCode Zen API key. */
  key?: string;
  /** Default language model name. */
  model?: string;
  /** Additional configuration values. */
  [key: string]: string | undefined;
}

/**
 * Reads the zencommit configuration from disk.
 *
 * @returns The parsed config object, or an empty object if the file does not
 *          exist or is not valid JSON.
 */
export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

/**
 * Writes the zencommit configuration to disk.
 *
 * Creates the parent directories if they don't exist.
 *
 * @param config - The configuration object to persist.
 */
export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configDirPath, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Returns the absolute path to the config JSON file.
 *
 * @returns The filesystem path to ``config.json``.
 */
export function getConfigPath(): string {
  return configPath;
}
