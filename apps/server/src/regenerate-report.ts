import { z } from "zod";
import { closeDatabase } from "./db.js";
import { safeStoredError } from "./services/operation-log.js";
import { queueReportRegeneration } from "./services/report-regeneration.js";
import { stopBoss } from "./services/queue.js";

try {
  const reportId = z.guid().parse(process.argv[2]);
  const result = await queueReportRegeneration(reportId);
  if (!result) throw new Error("Report not found");
  console.log(JSON.stringify({ reportId, runId: result.run.id, jobId: result.jobId,
    generationId: result.run.stats.generationId, status: result.run.status, alreadyActive: result.alreadyActive }));
} catch (error) {
  console.error(safeStoredError(error));
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closeDatabase();
}
