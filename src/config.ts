import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const configDirPath = join(configDir, "zencommit");
const configPath = join(configDirPath, "config.json");

export interface Config {
  key?: string;
  model?: string;
  [key: string]: string | undefined;
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configDirPath, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getConfigPath(): string {
  return configPath;
}
