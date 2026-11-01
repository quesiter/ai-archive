import { sql, type SQL } from "drizzle-orm";
import { conversations, conversationRevisions, devices } from "../schema.js";
import { mainConversationFilter } from "./conversation-lineage.js";

export function normalizeSourceDeviceName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu," ").trim().toLocaleLowerCase("en-US");
}

/** Logical source identity is the name, independent of pairing credentials. */
export function sourceDeviceKeySql(name: SQL = sql`${devices.name}`): SQL {
  return sql`case
    when ${name} is not null then 'name:' || lower(btrim(regexp_replace(normalize(${name}, NFKC), '[[:space:]]+', ' ', 'g')))
    when ${conversationRevisions.triggerReason} = 'historical_import'
      or ${conversationRevisions.adapterVersion} = 'chat-memo-text-v1' then 'historical_import'
    else 'unrecorded' end`;
}

export function sourceDeviceQueryKey(value: string): string {
  return value === "unrecorded" || value === "historical_import"
    ? value
    : `name:${normalizeSourceDeviceName(value.slice(5))}`;
}

export function buildSourceDeviceOptionsQuery(): SQL {
  return sql`
    select current_revision.device_key as key,
      coalesce(min(current_revision.device_name), case when current_revision.device_key = 'historical_import' then '历史文件导入' else '未记录设备' end) as name,
      count(*)::int as count
    from ${conversations} join lateral (
      select ${sourceDeviceKeySql()} as device_key,
        btrim(regexp_replace(normalize(${devices.name}, NFKC), '[[:space:]]+', ' ', 'g')) as device_name
      from ${conversationRevisions}
      left join ${devices} on ${devices.id} = ${conversationRevisions.sourceDeviceId}
      where ${conversationRevisions.conversationId} = ${conversations.id}
      order by ${conversationRevisions.isAccumulated} desc,
        (${conversationRevisions.completeness} = 'complete') desc,
        ${conversationRevisions.capturedAt} desc, ${conversationRevisions.createdAt} desc,
        ${conversationRevisions.id} desc limit 1
    ) current_revision on true
    where ${conversations.deletedAt} is null and ${mainConversationFilter()}
    group by current_revision.device_key order by (current_revision.device_key = 'unrecorded'), name
  `;
}
