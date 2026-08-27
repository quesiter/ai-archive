import { desc, eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  DeviceKindSchema,
  PairingClaimSchema,
} from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { errorMessage, requireDevice, requireWebUser } from "../http.js";
import { devices } from "../schema.js";
import {
  claimPairingCode,
  createPairingCode,
} from "../services/auth.js";
import { writeOperationLog } from "../services/operation-log.js";
import {
  discoverDeviceComponents,
  publicDeviceComponent,
  resolveDeviceComponent,
} from "../services/device-components.js";

const CreateCodeSchema = z.object({
  name: z.string().min(1).max(128),
  kind: DeviceKindSchema,
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/devices/claim", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
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
        clientVersion: devices.clientVersion,
        os: devices.os,
        lastScanAt: devices.lastScanAt,
        lastSuccessfulSyncAt: devices.lastSuccessfulSyncAt,
        lastErrorAt: devices.lastErrorAt,
        lastErrorCode: devices.lastErrorCode,
        trackedFiles: devices.trackedFiles,
        skippedFiles: devices.skippedFiles,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .orderBy(desc(devices.createdAt));
  });

  app.post("/api/v1/devices/heartbeat", async (request, reply) => {
    const device = await requireDevice(request, reply);
    if (!device) return;
    const input = z.object({
      clientVersion: z.string().min(1).max(64),
      os: z.string().min(1).max(120),
      lastScanAt: z.string().datetime({ offset: true }).optional(),
      lastSuccessfulSyncAt: z.string().datetime({ offset: true }).optional(),
      lastErrorAt: z.string().datetime({ offset: true }).nullable().optional(),
      lastErrorCode: z.string().max(120).nullable().optional(),
      trackedFiles: z.number().int().min(0).max(10_000_000),
      skippedFiles: z.number().int().min(0).max(10_000_000),
    }).parse(request.body);
    await db.update(devices).set({
      clientVersion: input.clientVersion,
      os: input.os,
      lastScanAt: input.lastScanAt ? new Date(input.lastScanAt) : new Date(),
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt
        ? new Date(input.lastSuccessfulSyncAt)
        : undefined,
      lastErrorAt: input.lastErrorAt === undefined
        ? undefined
        : input.lastErrorAt === null
          ? null
          : new Date(input.lastErrorAt),
      lastErrorCode: input.lastErrorCode,
      trackedFiles: input.trackedFiles,
      skippedFiles: input.skippedFiles,
      lastSeenAt: new Date(),
    }).where(eq(devices.id, device.id));
    return { ok: true };
  });

  app.get("/api/v1/device-components", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const components = await discoverDeviceComponents();
    return components.map(publicDeviceComponent);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/device-components/:id/download",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const { id } = z
        .object({ id: z.enum(["chrome", "windows", "macos"]) })
        .parse(request.params);
      const component = await resolveDeviceComponent(id);
      if (!component?.absolutePath || !component.filename) {
        return reply.code(404).send({ error: "Device component is not available" });
      }
      await writeOperationLog({
        scope: "device",
        message: `设备组件下载已开始：${component.name}`,
        status: "completed",
        entityType: "device_component",
        entityId: component.id,
        metadata: {
          filename: component.filename,
          version: component.version,
          sizeBytes: component.sizeBytes,
          userId: user.id,
        },
      });
      reply
        .header(
          "Content-Type",
          component.archiveType === "zip"
            ? "application/zip"
            : "application/gzip",
        )
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(component.filename)}`,
        )
        .header("Content-Length", String(component.sizeBytes ?? 0))
        .header("Cache-Control", "private, no-store");
      return reply.send(createReadStream(component.absolutePath));
    },
  );

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
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ name: z.string().min(1).max(128) }).parse(request.body);
      const [device] = await db
        .update(devices)
        .set({ name: input.name })
        .where(eq(devices.id, id))
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
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [existing] = await db
        .select({ id: devices.id, revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "Device not found" });
      if (existing.revokedAt) {
        await db.delete(devices).where(eq(devices.id, id));
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
          .where(eq(devices.id, id));
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
