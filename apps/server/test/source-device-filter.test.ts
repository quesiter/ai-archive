import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks=vi.hoisted(()=>({ execute:vi.fn(), insert:vi.fn() }));
vi.mock("../src/db.js",()=>({ db:mocks }));
vi.mock("../src/http.js",()=>({requireWebUser:vi.fn(async()=>true)}));
import { conversationRoutes } from "../src/routes/conversations.js";
import { currentConversationRevisionFilter } from "../src/services/conversation-list-query.js";
import { buildSourceDeviceOptionsQuery, normalizeSourceDeviceName, sourceDeviceQueryKey } from "../src/services/source-devices.js";
beforeEach(()=>vi.clearAllMocks());
describe("logical source device filtering",()=>{
 it("combines names independent of capitalization, width and whitespace",()=>{
  expect(normalizeSourceDeviceName("  ＱＭＬ－ＰＣ  ")).toBe("qml-pc");
  expect(sourceDeviceQueryKey("name:QML-PC")).toBe("name:qml-pc");
  expect(sourceDeviceQueryKey("unrecorded")).toBe("unrecorded");
  expect(sourceDeviceQueryKey("historical_import")).toBe("historical_import");
 });
 it("groups current main conversation sources by name, including revoked and missing devices",()=>{
  const query=new PgDialect().sqlToQuery(buildSourceDeviceOptionsQuery());
  expect(query.sql).toContain("group by current_revision.device_key");
  expect(query.sql).toContain("join lateral");
  expect(query.sql).toContain("limit 1");
  expect(query.sql).not.toContain("row_number");
  expect(query.sql).toContain('left join "devices"');
  expect(query.sql).toContain("normalize(");
  expect(query.sql).not.toContain("revoked_at");
 });
 it.each(["name: QML-PC ","unrecorded","historical_import","name:100%_' Device"])("filters indexed current revisions by the same normalized source key (%s)",(value)=>{
  const query=new PgDialect().sqlToQuery(currentConversationRevisionFilter({sourceDevice:value})!);
  expect(query.sql).toContain("current_revision.source_device_key = ");
  expect(query.sql).toContain("left join devices device");
  expect(query.sql).toContain('revision.conversation_id = "conversations"."id"');
  expect(query.sql).toContain("revision.is_accumulated desc");
  expect(query.sql).toContain("limit 1");
  expect(query.sql).not.toContain("row_number");
  expect(query.params).toContain(sourceDeviceQueryKey(value));
 });
 it("rejects malformed device selectors before database access",async()=>{
  const app=Fastify();await app.register(conversationRoutes);
  try{
   const result=await app.inject({method:"GET",url:"/api/v1/conversations?sourceDevice=random"});
   expect(result.statusCode).toBe(400);expect(mocks.execute).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
});import { savedSearchRoutes } from "../src/routes/saved-searches.js";
it("keeps source device identity in saved views",async()=>{
 const values: any[]=[];
 mocks.insert.mockReturnValue({values:(value:unknown)=>({returning:async()=>{values.push(value);return [{id:"saved",...(value as object)}];}})});
 const app=Fastify();await app.register(savedSearchRoutes);
 try{
  const result=await app.inject({method:"POST",url:"/api/v1/saved-searches",payload:{name:"QML-PC会话",query:{sourceDevice:"name:qml-pc",provider:"codex",offset:"100"}}});
  expect(result.statusCode).toBe(201);
  expect(values[0].query).toEqual({sourceDevice:"name:qml-pc",provider:"codex"});
 }finally{await app.close();}
});
