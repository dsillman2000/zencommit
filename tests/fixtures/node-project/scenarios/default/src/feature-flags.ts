export interface FeatureFlag {
  name: string;
  enabled: boolean;
}

const flags: Map<string, boolean> = new Map([
  ["dark-mode", false],
  ["beta-api", true],
  ["new-dashboard", false],
]);

export function isEnabled(name: string): boolean {
  return flags.get(name) ?? false;
}

export function setFlag(name: string, value: boolean): void {
  flags.set(name, value);
}
