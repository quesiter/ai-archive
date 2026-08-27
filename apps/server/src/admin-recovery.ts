#!/usr/bin/env node
import { closeDatabase } from "./db.js";
import {
  recoverAdminPassword,
  recoverAdminTotp,
  revokeAllWebSessions,
} from "./services/auth.js";

function usage(): never {
  console.error(`知言归藏管理员恢复工具

仅应在拥有服务器 Shell 和 APP_MASTER_KEY 的环境执行：
  node dist/admin-recovery.js reset-password
  node dist/admin-recovery.js reset-totp
  node dist/admin-recovery.js revoke-sessions

reset-password 从 AI_ARCHIVE_RECOVERY_PASSWORD 读取新密码（至少 12 个字符）。`);
  process.exitCode = 2;
  throw new Error("Invalid recovery command");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "reset-password") {
    const password = process.env.AI_ARCHIVE_RECOVERY_PASSWORD ?? "";
    if (password.length < 12 || password.length > 256) {
      throw new Error("AI_ARCHIVE_RECOVERY_PASSWORD must contain 12 to 256 characters");
    }
    const username = await recoverAdminPassword(password);
    console.log(`Password reset for ${username}; all web sessions were revoked.`);
    return;
  }
  if (command === "reset-totp") {
    const result = await recoverAdminTotp();
    console.log(`TOTP reset for ${result.username}; all web sessions were revoked.`);
    console.log(`Secret: ${result.secret}`);
    console.log(`OTP URI: ${result.otpauthUrl}`);
    return;
  }
  if (command === "revoke-sessions") {
    console.log(`Revoked ${await revokeAllWebSessions()} web sessions.`);
    return;
  }
  usage();
}

main()
  .catch((error) => {
    if (process.exitCode !== 2) console.error(error instanceof Error ? error.message : error);
    process.exitCode = process.exitCode || 1;
  })
  .finally(() => closeDatabase());
