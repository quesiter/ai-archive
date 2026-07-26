import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { reports } from "../schema.js";
import { getSetting } from "./settings.js";

type ReportRow = typeof reports.$inferSelect;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendReportEmail(report: ReportRow): Promise<void> {
  const [host, port, secure, username, password, from, to] = await Promise.all([
    getSetting("smtp.host"),
    getSetting("smtp.port"),
    getSetting("smtp.secure"),
    getSetting("smtp.username"),
    getSetting("smtp.password"),
    getSetting("smtp.from"),
    getSetting("smtp.to"),
  ]);
  if (!host || !port || !from || !to) return;
  const transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: secure === "true",
    auth: username ? { user: username, pass: password ?? "" } : undefined,
  });
  const reportUrl = `${config.APP_ORIGIN}/reports/${report.id}`;
  await transporter.sendMail({
    from,
    to,
    subject: report.title,
    text: `${report.summary}\n\n查看完整报告：${reportUrl}`,
    html: `<p>${escapeHtml(report.summary)}</p><p><a href="${escapeHtml(reportUrl)}">查看完整报告</a></p>`,
  });
}

export async function sendReportEmailById(reportId: string): Promise<void> {
  const [report] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!report) throw new Error(`Report not found: ${reportId}`);
  await sendReportEmail(report);
}
