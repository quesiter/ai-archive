import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "./db.js";
import { backfillSearchDocumentTerms } from "./services/search-documents.js";
import { backfillArchiveReadModels } from "./services/archive-read-models.js";

const migrationsFolder = resolve(process.cwd(), "migrations");

await migrate(db, { migrationsFolder });
await backfillArchiveReadModels();
await backfillSearchDocumentTerms();
await closeDatabase();
console.log("Database migrations completed.");
