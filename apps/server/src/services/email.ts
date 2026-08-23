import nodemailer from "nodemailer";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { reports } from "../schema.js";
import { getSetting } from "./settings.js";
import { resolveSafeNetworkHost } from "./network-target.js";

type ReportRow = typeof reports.$inferSelect;

export interface SmtpConfigInput {
  host?: string;
  port?: string;
  secure?: string;
  username?: string;
  password?: string;
  from?: string;
  to?: string;
}

interface SmtpConfig {
  host: string;
  port: string;
  secure: string;
  username: string;
  password: string;
  from: string;
  to: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadSmtpConfig(input: SmtpConfigInput = {}): Promise<SmtpConfig> {
  const [storedHost, storedPort, storedSecure, storedUsername, storedPassword, storedFrom, storedTo] = await Promise.all([
    getSetting("smtp.host"),
    getSetting("smtp.port"),
    getSetting("smtp.secure"),
    getSetting("smtp.username"),
    getSetting("smtp.password"),
    getSetting("smtp.from"),
    getSetting("smtp.to"),
  ]);
  const selected = (value: string | undefined, fallback: string | null) =>
    (value === undefined ? fallback : value) ?? "";
  return {
    host: selected(input.host, storedHost).trim(),
    port: selected(input.port, storedPort).trim(),
    secure: selected(input.secure, storedSecure).trim(),
    username: selected(input.username, storedUsername).trim(),
    password: input.password === undefined || input.password === "********"
      ? storedPassword ?? ""
      : input.password,
    from: selected(input.from, storedFrom).trim(),
    to: selected(input.to, storedTo).trim(),
  };
}

async function createSmtpTransport(smtp: SmtpConfig) {
  const numericPort = Number(smtp.port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error("SMTP 端口必须是 1 到 65535 之间的整数");
  }
  if (smtp.secure !== "true" && smtp.secure !== "false") {
    throw new Error("SMTP 安全连接配置必须为 true 或 false");
  }
  const resolved = await resolveSafeNetworkHost(smtp.host);
  const selectedAddress = resolved.addresses[0]!;
  return nodemailer.createTransport({
    // Connect to the exact address that passed the SSRF check. Keeping the
    // original hostname as TLS servername preserves certificate validation.
    host: selectedAddress.address,
    port: numericPort,
    secure: smtp.secure === "true",
    tls: isIP(smtp.host.replace(/^\[|\]$/g, ""))
      ? undefined
      : { servername: smtp.host },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: smtp.username
      ? { user: smtp.username, pass: smtp.password }
      : undefined,
  });
}

export async function sendReportEmail(report: ReportRow): Promise<void> {
  const smtp = await loadSmtpConfig();
  if (!smtp.host || !smtp.port || !smtp.from || !smtp.to) return;
  const transporter = await createSmtpTransport(smtp);
  const reportUrl = `${config.APP_ORIGIN}/reports/${report.id}`;
  try {
    await transporter.sendMail({
      from: smtp.from,
      to: smtp.to,
      subject: report.title,
      text: `${report.summary}\n\n查看完整报告：${reportUrl}`,
      html: `<p>${escapeHtml(report.summary)}</p><p><a href="${escapeHtml(reportUrl)}">查看完整报告</a></p>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } finally {
    transporter.close();
  }
}

export async function testReportEmail(input: SmtpConfigInput): Promise<{
  to: string;
  messageId: string;
}> {
  const smtp = await loadSmtpConfig(input);
  if (!smtp.host || !smtp.port || !smtp.from || !smtp.to) {
    throw new Error("请完整填写 SMTP 主机、端口、发件人和收件人");
  }
  const transporter = await createSmtpTransport(smtp);
  try {
    await transporter.verify();
    const sentAt = new Date();
    const info = await transporter.sendMail({
      from: smtp.from,
      to: smtp.to,
      subject: "知言归藏 · 邮箱测试",
      text: `这是一封测试邮件。SMTP 连接、身份验证和邮件投递请求均已成功。\n\n发送时间：${sentAt.toISOString()}`,
      html: `<p>这是一封测试邮件。SMTP 连接、身份验证和邮件投递请求均已成功。</p><p>发送时间：${escapeHtml(sentAt.toISOString())}</p>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    if (accepted.length === 0) {
      throw new Error("SMTP 服务器未接受任何收件人，请检查收件人地址");
    }
    return { to: smtp.to, messageId: String(info.messageId ?? "") };
  } finally {
    transporter.close();
  }
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
