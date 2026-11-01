import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDevice, requireWebUser } from "../http.js";
import { changeRecaptureJob, createRecaptureJob, listRecaptureJobs, nextRecaptureTask, reportRecaptureTask } from "../services/recapture.js";

const CreateSchema = z.object({ deviceId: z.guid(), conversationIds: z.array(z.guid()).min(1).max(500).optional(), allIncomplete: z.literal(true).optional() })
  .refine(value => Boolean(value.conversationIds) !== Boolean(value.allIncomplete), "Specify selected conversations or all incomplete");
const ReportSchema = z.object({ jobId: z.guid(), itemId: z.guid(), leaseToken: z.guid(),
  captureId: z.string().min(1).max(200).optional(), outcome: z.enum(["failed", "attention", "skipped"]).optional(), message: z.string().max(500).optional() })
  .refine(value => Boolean(value.captureId) !== Boolean(value.outcome), "Specify a capture receipt or failure");

export async function recaptureRoutes(app: FastifyInstance) {
  app.get("/api/v1/recapture/jobs", async (request, reply) => {
    if (!await requireWebUser(request, reply)) return;
    return listRecaptureJobs();
  });
  app.post("/api/v1/recapture/jobs", async (request, reply) => {
    if (!await requireWebUser(request, reply)) return;
    const body = CreateSchema.parse(request.body);
    return createRecaptureJob(body.deviceId, body.conversationIds ? [...new Set(body.conversationIds)] : undefined);
  });
  app.post("/api/v1/recapture/jobs/:id", async (request, reply) => {
    if (!await requireWebUser(request, reply)) return;
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const { action } = z.object({ action: z.enum(["pause", "resume", "cancel", "retry_failed", "retry_partial", "retry_skipped", "skip_current"]) }).parse(request.body);
    return changeRecaptureJob(id, action);
  });
  app.post("/api/v1/recapture/next", async (request, reply) => {
    const device = await requireDevice(request, reply);
    if (!device) return;
    if (device.kind !== "chrome_extension") return reply.code(403).send({ error: "Chrome extension required" });
    const { leaseToken } = z.object({ leaseToken: z.guid().optional() }).parse(request.body ?? {});
    return nextRecaptureTask(device.id, leaseToken);
  });
  app.post("/api/v1/recapture/report", async (request, reply) => {
    const device = await requireDevice(request, reply);
    if (!device) return;
    if (device.kind !== "chrome_extension") return reply.code(403).send({ error: "Chrome extension required" });
    return reportRecaptureTask(device.id, ReportSchema.parse(request.body));
  });
}
