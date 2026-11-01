import { closeDatabase } from "./db.js";
import { accumulationCandidates, consolidateArchiveConversations } from "./services/conversation-accumulation.js";

try {
  if (!process.argv.includes("--execute")) {
    const candidates = await accumulationCandidates();
    console.log(JSON.stringify({ execute: false, conversations: candidates.length,
      revisions: candidates.reduce((sum, row) => sum + row.revisionCount, 0),
      message: "Back up the archive, then pass --execute to consolidate stored conversations." }));
  } else {
    const result = await consolidateArchiveConversations(async (progress) => {
      console.log(JSON.stringify({ ...progress, phase: "accumulating" }));
    });
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Conversation accumulation failed");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
