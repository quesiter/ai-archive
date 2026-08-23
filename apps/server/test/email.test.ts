import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  createTransport: vi.fn(),
  verify: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

vi.mock("../src/config.js", () => ({
  config: { APP_ORIGIN: "https://archive.example.test" },
}));

vi.mock("../src/db.js", () => ({
  db: {},
}));

vi.mock("../src/services/settings.js", () => ({
  getSetting: vi.fn(async (key: string) => mocks.settings.get(key) ?? null),
}));

vi.mock("../src/services/network-target.js", () => ({
  resolveSafeNetworkHost: vi.fn(async (hostname: string) => ({
    hostname,
    addresses: [{ address: "1.1.1.1", family: 4 }],
  })),
}));

import { testReportEmail } from "../src/services/email.js";

beforeEach(() => {
  mocks.settings = new Map([["smtp.password", "stored-secret"]]);
  mocks.verify.mockReset().mockResolvedValue(true);
  mocks.sendMail.mockReset().mockResolvedValue({
    accepted: ["recipient@example.com"],
    rejected: [],
    messageId: "test-message-id",
  });
  mocks.close.mockReset();
  mocks.createTransport.mockReset().mockReturnValue({
    verify: mocks.verify,
    sendMail: mocks.sendMail,
    close: mocks.close,
  });
});

describe("report email test", () => {
  it("verifies SMTP and sends a real test message with the saved masked password", async () => {
    const result = await testReportEmail({
      host: "smtp.example.com",
      port: "587",
      secure: "false",
      username: "sender@example.com",
      password: "********",
      from: "sender@example.com",
      to: "recipient@example.com",
    });

    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "1.1.1.1",
      port: 587,
      auth: { user: "sender@example.com", pass: "stored-secret" },
    }));
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "recipient@example.com",
      subject: "知言归藏 · 邮箱测试",
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(result).toEqual({
      to: "recipient@example.com",
      messageId: "test-message-id",
    });
  });

  it("rejects incomplete SMTP settings before opening a connection", async () => {
    await expect(testReportEmail({
      host: "",
      port: "587",
      from: "",
      to: "",
    })).rejects.toThrow(/完整填写/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("reports when the SMTP server rejects every recipient", async () => {
    mocks.sendMail.mockResolvedValue({ accepted: [], rejected: ["recipient@example.com"] });
    await expect(testReportEmail({
      host: "smtp.example.com",
      port: "465",
      secure: "true",
      from: "sender@example.com",
      to: "recipient@example.com",
    })).rejects.toThrow(/未接受任何收件人/);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
