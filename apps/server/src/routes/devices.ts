import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  DeviceKindSchema,
  PairingClaimSchema,
} from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { errorMessage, requireWebUser } from "../http.js";
import { devices } from "../schema.js";
import {
  claimPairingCode,
  createPairingCode,
} from "../services/auth.js";
import { writeOperationLog } from "../services/operation-log.js";

const CreateCodeSchema = z.object({
  name: z.string().min(1).max(128),
  kind: DeviceKindSchema,
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/devices/claim", async (request, reply) => {
    try {
      const input = PairingClaimSchema.parse(request.body);
      const claimed = await claimPairingCode(input);
      await writeOperationLog({
        scope: "device",
        message: `设备已配对：${claimed.name}`,
        status: "active",
        entityType: "device",
        entityId: claimed.deviceId,
        metadata: { kind: input.kind, name: claimed.name },
      });
      return claimed;
    } catch (error) {
      await writeOperationLog({
        scope: "device",
        level: "warning",
        message: "设备配对失败",
        status: "failed",
        metadata: { error: errorMessage(error) },
      });
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/devices", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db
      .select({
        id: devices.id,
        name: devices.name,
        kind: devices.kind,
        createdAt: devices.createdAt,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .orderBy(desc(devices.createdAt));
  });

  app.post("/api/v1/pairing-codes", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    try {
      const input = CreateCodeSchema.parse(request.body);
      const code = await createPairingCode(input);
      await writeOperationLog({
        scope: "device",
        message: `配对码已生成：${input.name}`,
        status: "queued",
        entityType: "pairing_code",
        metadata: { kind: input.kind, name: input.name, expiresAt: code.expiresAt },
      });
      return reply.code(201).send(code);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/devices/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const input = z.object({ name: z.string().min(1).max(128) }).parse(request.body);
      const [device] = await db
        .update(devices)
        .set({ name: input.name })
        .where(eq(devices.id, request.params.id))
        .returning({
          id: devices.id,
          name: devices.name,
          kind: devices.kind,
          createdAt: devices.createdAt,
          lastSeenAt: devices.lastSeenAt,
          revokedAt: devices.revokedAt,
        });
      if (!device) return reply.code(404).send({ error: "Device not found" });
      await writeOperationLog({
        scope: "device",
        message: `设备已重命名：${device.name}`,
        status: device.revokedAt ? "revoked" : "active",
        entityType: "device",
        entityId: device.id,
        metadata: { kind: device.kind, name: device.name },
      });
      return device;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/devices/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const [existing] = await db
        .select({ id: devices.id, revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, request.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "Device not found" });
      if (existing.revokedAt) {
        await db.delete(devices).where(eq(devices.id, request.params.id));
        await writeOperationLog({
          scope: "device",
          message: "已删除撤销设备",
          status: "deleted",
          entityType: "device",
          entityId: existing.id,
        });
      } else {
        await db
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(eq(devices.id, request.params.id));
        await writeOperationLog({
          scope: "device",
          message: "设备已撤销",
          status: "revoked",
          entityType: "device",
          entityId: existing.id,
        });
      }
      return reply.code(204).send();
    },
  );
}
