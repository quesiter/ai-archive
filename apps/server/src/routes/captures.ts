import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { errorMessage, requireDevice } from "../http.js";
import {
  IncrementalBaseMismatchError,
  ingestCapture,
  recordCaptureFailure,
} from "../services/capture.js";
import { CaptureTriggerReasonSchema, ProviderSchema } from "@ai-archive/contracts";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueConversationClassification } from "../services/queue.js";
import { getBooleanSetting } from "../services/settings.js";

export async function captureRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/captures", async (request, reply) => {
    const device = await requireDevice(request, reply);
    if (!device) return;
    const rawIdempotencyKey = request.headers["idempotency-key"];
    const idempotencyKey =
      typeof rawIdempotencyKey === "string" && rawIdempotencyKey.length <= 512
        ? rawIdempotencyKey
        : undefined;
    if (rawIdempotencyKey && !idempotencyKey) {
      return reply.code(400).send({ error: "Idempotency-Key must be at most 512 characters" });
    }
    try {
      const result = await ingestCapture(request.body, device.id, idempotencyKey);
      const candidate = request.body as Record<string, unknown> | null;
      if (!result.unchanged) {
        await writeOperationLog({
          scope: "capture",
          message:
            result.captureMode === "append"
              ? `增量采集已归档：${result.messageCount} 条消息`
              : `完整采集已归档：${result.messageCount} 条消息`,
          status: result.completeness,
          entityType: "conversation",
          entityId: result.conversationId,
          metadata: {
            provider: candidate?.provider,
            sessionId: candidate?.sessionId,
            revisionId: result.revisionId,
            captureMode: result.captureMode,
            triggerReason: result.triggerReason,
            completeness: result.completeness,
            messageCount: result.messageCount,
            deviceId: device.id,
          },
        });
      }
      if (
        !result.unchanged &&
        (await getBooleanSetting("classification.autoOnCapture", false))
      ) {
        try {
          await enqueueConversationClassification(result.conversationId);
        } catch (error) {
          // Archiving is the source of truth. A temporarily unavailable analysis
          // queue must not turn a successful capture into a client-visible error.
          request.log.warn({ error: errorMessage(error) }, "Failed to queue AI classification");
          await writeOperationLog({
            scope: "classification",
            level: "warning",
            message: "采集后自动归类入队失败",
            status: "failed",
            entityType: "conversation",
            entityId: result.conversationId,
            metadata: { error: errorMessage(error) },
          });
        }
      }
      return reply.code(result.unchanged ? 200 : 201).send(result);
    } catch (error) {
      const candidate = request.body as Record<string, unknown> | null;
      if (error instanceof IncrementalBaseMismatchError) {
        await writeOperationLog({
          scope: "capture",
          level: "warning",
          message: "增量采集基线不一致，需要回退完整采集",
          status: "failed",
          entityType: "capture",
          entityId: typeof candidate?.sessionId === "string" ? candidate.sessionId : null,
          metadata: {
            provider: candidate?.provider,
            sessionId: candidate?.sessionId,
            baseRevisionId: candidate?.baseRevisionId,
            baseMessageCount: candidate?.baseMessageCount,
            error: error.message,
          },
        });
        return reply.code(409).send({
          error: error.code,
          message: error.message,
          requiresFullCapture: true,
        });
      }
      const providerResult = ProviderSchema.safeParse(candidate?.provider);
      if (providerResult.success && typeof candidate?.sessionId === "string") {
        const triggerReason = CaptureTriggerReasonSchema.safeParse(
          candidate.triggerReason,
        );
        await recordCaptureFailure({
          deviceId: device.id,
          provider: providerResult.data,
          sessionId: candidate.sessionId,
          capturedAt:
            typeof candidate.capturedAt === "string"
              ? new Date(candidate.capturedAt)
              : new Date(),
          error: errorMessage(error),
          captureMode: candidate.captureMode === "append" ? "append" : "full",
          ...(triggerReason.success ? { triggerReason: triggerReason.data } : {}),
        });
        await writeOperationLog({
          scope: "capture",
          level: "error",
          message: "采集快照解析失败",
          status: "failed",
          entityType: "capture",
          entityId: candidate.sessionId,
          metadata: {
            provider: providerResult.data,
            sessionId: candidate.sessionId,
            deviceId: device.id,
            error: errorMessage(error),
          },
        });
      }
      return reply.code(400).send({
        error: errorMessage(error),
        issues:
          error instanceof ZodError ||
          (error instanceof Error &&
            error.name === "ZodError" &&
            "issues" in error &&
            Array.isArray(error.issues))
            ? (error as { issues: unknown[] }).issues
            : undefined,
      });
    }
  });
}
