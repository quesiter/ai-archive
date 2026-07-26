import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { stopBoss } from "./services/queue.js";

const app = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await stopBoss();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

await app.listen({ host: "0.0.0.0", port: config.PORT });
