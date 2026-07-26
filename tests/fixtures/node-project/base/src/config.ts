export interface AppConfig {
  port: number;
  secret: string;
  env: string;
  debug: boolean;
}

export const config: AppConfig = {
  port: 3000,
  secret: "dev-secret",
  env: "development",
  debug: true,
};
