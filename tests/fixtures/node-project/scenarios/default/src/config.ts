export interface AppConfig {
  port: number;
  secret: string;
  env: string;
  debug: boolean;
  maxRetries: number;
}

export const config: AppConfig = {
  port: 3000,
  secret: "dev-secret",
  env: "staging",
  debug: false,
  maxRetries: 3,
};
