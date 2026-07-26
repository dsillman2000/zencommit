import { config } from "./config.js";
import { startServer } from "./api.js";

function main() {
  const port = config.port || 3000;
  startServer(port);
}

main();
