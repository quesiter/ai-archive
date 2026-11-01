import { readdir, readFile, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "../apps/server/src/db.js";
import { conversationRevisions } from "../apps/server/src/schema.js";
const root="/data/restores/anonymous-duplicate-repair-20261007";
try {
 const files=(await readdir(root)).filter(name => name.endsWith(".json")).sort((a,b)=>Number(a.split("-").at(-1)!.replace(".json",""))-Number(b.split("-").at(-1)!.replace(".json","")));
 const seen=new Set<string>();
 const before: unknown[]=[];
 let restored=0, skipped=0;
 await db.transaction(async tx => {
  for(const file of files) {
   const backup=JSON.parse(await readFile(`${root}/${file}`,"utf8"));
   const original=backup.revision;
   if(seen.has(original.id)) continue;
   seen.add(original.id);
   const [current]=await tx.select().from(conversationRevisions).where(eq(conversationRevisions.id,original.id));
   if(!current || current.capturedAt.toISOString() !== new Date(original.capturedAt).toISOString()) {skipped++;continue;}
   if(current.captureMode === original.captureMode && current.triggerReason === original.triggerReason) continue;
   before.push({id:current.id,captureMode:current.captureMode,triggerReason:current.triggerReason,capturedAt:current.capturedAt});
  }
  await writeFile(`/data/restores/mixed-id-provenance-before-${Date.now()}.json`,JSON.stringify(before),{mode:0o600,flag:"wx"});
  for(const file of files) {
   const backup=JSON.parse(await readFile(`${root}/${file}`,"utf8"));
   const original=backup.revision;
   const row=before.find((value:any)=>value.id===original.id);
   if(!row) continue;
   await tx.update(conversationRevisions).set({captureMode:original.captureMode,triggerReason:original.triggerReason}).where(eq(conversationRevisions.id,original.id));
   before.splice(before.indexOf(row),1);
   restored++;
  }
 });
 console.log(JSON.stringify({checked:seen.size,restored,skipped}));
} finally {await closeDatabase();}