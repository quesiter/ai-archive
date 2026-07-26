import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "./db.js";

const migrationsFolder = resolve(process.cwd(), "migrations");

await migrate(db, { migrationsFolder });
await closeDatabase();
console.log("Database migrations completed.");
