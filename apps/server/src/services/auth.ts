import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import type { DeviceKind, PairingClaim } from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  devices,
  pairingCodes,
  users,
  webSessions,
} from "../schema.js";
import {
  decryptSecret,
  encryptSecret,
  randomPairingCode,
  randomToken,
  sha256,
} from "./crypto.js";

const WEB_SESSION_DAYS = 30;
const PENDING_TOTP_MINUTES = 10;
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$hw8wQUjy5Rh5SOo41guauQ$3oNTAJQ5Fv5YWslDsTK7i9Uketwtv2ylpdR8F8vV/lc";

export async function isInitialized(): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  return Boolean(user);
}

export async function bootstrapAdmin(input: {
  username: string;
  password: string;
}): Promise<{ secret: string; otpauthUrl: string }> {
  const totp = new OTPAuth.TOTP({
    issuer: "知言归藏",
    label: input.username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  const secret = totp.secret.base32;
  const passwordHash = await hash(input.password, {
      memoryCost: 19_456,
      timeCost: 2,
      outputLen: 32,
      parallelism: 1,
  });
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(742938515)`);
    const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new Error("Administrator already initialized");
    await tx.insert(users).values({
      singletonKey: 1,
      username: input.username,
      passwordHash,
      totpSecretEncrypted: encryptSecret(secret),
    });
  });
  return { secret, otpauthUrl: totp.toString() };
}

export async function login(input: {
  username: string;
  password: string;
  totpCode: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  const passwordValid = await verify(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
  if (!user || !passwordValid) {
    throw new Error("Invalid username, password, or TOTP code");
  }
  const totp = new OTPAuth.TOTP({
    issuer: "知言归藏",
    label: user.username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totpSecretEncrypted)),
  });
  const delta = totp.validate({ token: input.totpCode, window: 1 });
  if (delta === null) {
    throw new Error("Invalid username, password, or TOTP code");
  }
  const token = randomToken();
  const expiresAt = new Date(Date.now() + WEB_SESSION_DAYS * 86_400_000);
  await db.insert(webSessions).values({
    tokenHash: sha256(token),
    userId: user.id,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function authenticateWebSession(
  token: string | undefined,
): Promise<{ id: string; username: string } | null> {
  if (!token) return null;
  const [result] = await db
    .select({ id: users.id, username: users.username })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .where(
      and(
        eq(webSessions.tokenHash, sha256(token)),
        gt(webSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return result ?? null;
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256(token)));
}

export async function cleanupExpiredAuthState(): Promise<void> {
  await db.delete(webSessions).where(lt(webSessions.expiresAt, new Date()));
  await db
    .delete(pairingCodes)
    .where(
      or(lt(pairingCodes.expiresAt, new Date()), isNotNull(pairingCodes.claimedAt)),
    );
  await db
    .update(users)
    .set({ pendingTotpSecretEncrypted: null, pendingTotpExpiresAt: null })
    .where(lt(users.pendingTotpExpiresAt, new Date()));
}

async function verifyAdminCredentials(input: {
  userId: string;
  currentPassword: string;
  totpCode: string;
}) {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user || !(await verify(user.passwordHash, input.currentPassword))) {
    throw Object.assign(new Error("Current password or TOTP code is invalid"), { statusCode: 401 });
  }
  const totp = new OTPAuth.TOTP({
    issuer: "知言归藏",
    label: user.username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(decryptSecret(user.totpSecretEncrypted)),
  });
  if (totp.validate({ token: input.totpCode, window: 1 }) === null) {
    throw Object.assign(new Error("Current password or TOTP code is invalid"), { statusCode: 401 });
  }
  return user;
}

export async function changeAdminPassword(input: {
  userId: string;
  currentPassword: string;
  totpCode: string;
  newPassword: string;
}): Promise<void> {
  await verifyAdminCredentials(input);
  const passwordHash = await hash(input.newPassword, {
    memoryCost: 19_456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
  await db.update(users).set({ passwordHash }).where(eq(users.id, input.userId));
}

function createAdminTotp(username: string) {
  return new OTPAuth.TOTP({
    issuer: "知言归藏",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
}

export async function startAdminTotpReset(input: {
  userId: string;
  currentPassword: string;
  totpCode: string;
}): Promise<{ secret: string; otpauthUrl: string; expiresAt: Date }> {
  const user = await verifyAdminCredentials(input);
  const totp = createAdminTotp(user.username);
  const secret = totp.secret.base32;
  const expiresAt = new Date(Date.now() + PENDING_TOTP_MINUTES * 60_000);
  await db.update(users).set({
    pendingTotpSecretEncrypted: encryptSecret(secret),
    pendingTotpExpiresAt: expiresAt,
  }).where(eq(users.id, user.id));
  return { secret, otpauthUrl: totp.toString(), expiresAt };
}

export async function confirmAdminTotpReset(input: {
  userId: string;
  totpCode: string;
}): Promise<void> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(742938516)`);
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user?.pendingTotpSecretEncrypted || !user.pendingTotpExpiresAt) {
      throw Object.assign(new Error("No pending TOTP reset"), { statusCode: 409 });
    }
    if (user.pendingTotpExpiresAt <= new Date()) {
      await tx.update(users).set({
        pendingTotpSecretEncrypted: null,
        pendingTotpExpiresAt: null,
      }).where(eq(users.id, user.id));
      return "expired" as const;
    }
    const secret = decryptSecret(user.pendingTotpSecretEncrypted);
    const totp = new OTPAuth.TOTP({
      issuer: "知言归藏",
      label: user.username,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    if (totp.validate({ token: input.totpCode, window: 1 }) === null) {
      throw Object.assign(new Error("New TOTP code is invalid"), { statusCode: 401 });
    }
    await tx.update(users).set({
      totpSecretEncrypted: user.pendingTotpSecretEncrypted,
      pendingTotpSecretEncrypted: null,
      pendingTotpExpiresAt: null,
    }).where(eq(users.id, user.id));
    return "activated" as const;
  });
  if (result === "expired") {
    throw Object.assign(new Error("Pending TOTP reset has expired"), { statusCode: 409 });
  }
}

export async function cancelAdminTotpReset(userId: string): Promise<void> {
  await db.update(users).set({
    pendingTotpSecretEncrypted: null,
    pendingTotpExpiresAt: null,
  }).where(eq(users.id, userId));
}

export async function recoverAdminPassword(newPassword: string): Promise<string> {
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("Administrator is not initialized");
  const passwordHash = await hash(newPassword, {
    memoryCost: 19_456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.delete(webSessions).where(eq(webSessions.userId, user.id));
  });
  return user.username;
}

export async function recoverAdminTotp(): Promise<{ username: string; secret: string; otpauthUrl: string }> {
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("Administrator is not initialized");
  const totp = createAdminTotp(user.username);
  const secret = totp.secret.base32;
  await db.transaction(async (tx) => {
    await tx.update(users).set({
      totpSecretEncrypted: encryptSecret(secret),
      pendingTotpSecretEncrypted: null,
      pendingTotpExpiresAt: null,
    }).where(eq(users.id, user.id));
    await tx.delete(webSessions).where(eq(webSessions.userId, user.id));
  });
  return { username: user.username, secret, otpauthUrl: totp.toString() };
}

export async function revokeAllWebSessions(): Promise<number> {
  const rows = await db.delete(webSessions).returning({ id: webSessions.id });
  return rows.length;
}

export async function listWebSessions(userId: string, currentToken?: string) {
  const currentHash = currentToken ? sha256(currentToken) : null;
  const rows = await db
    .select({
      id: webSessions.id,
      tokenHash: webSessions.tokenHash,
      createdAt: webSessions.createdAt,
      expiresAt: webSessions.expiresAt,
    })
    .from(webSessions)
    .where(and(eq(webSessions.userId, userId), gt(webSessions.expiresAt, new Date())));
  return rows.map(({ tokenHash, ...session }) => ({
    ...session,
    current: tokenHash === currentHash,
  }));
}

export async function revokeWebSession(userId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(webSessions)
    .where(and(eq(webSessions.id, sessionId), eq(webSessions.userId, userId)))
    .returning({ id: webSessions.id });
  return rows.length > 0;
}

export async function revokeOtherWebSessions(userId: string, currentToken?: string): Promise<number> {
  const currentHash = currentToken ? sha256(currentToken) : "";
  const rows = await db
    .delete(webSessions)
    .where(and(eq(webSessions.userId, userId), ne(webSessions.tokenHash, currentHash)))
    .returning({ id: webSessions.id });
  return rows.length;
}

export async function createPairingCode(input: {
  name: string;
  kind: DeviceKind;
}): Promise<{ code: string; expiresAt: Date }> {
  const code = randomPairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(pairingCodes).values({
    codeHash: sha256(code),
    requestedName: input.name,
    requestedKind: input.kind,
    expiresAt,
  });
  return { code, expiresAt };
}

export async function claimPairingCode(
  input: PairingClaim,
): Promise<{ deviceId: string; token: string; name: string }> {
  return db.transaction(async (tx) => {
    const [pairing] = await tx
      .update(pairingCodes)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(pairingCodes.codeHash, sha256(input.code.toUpperCase())),
          eq(pairingCodes.requestedKind, input.kind),
          gt(pairingCodes.expiresAt, new Date()),
          isNull(pairingCodes.claimedAt),
        ),
      )
      .returning();
    if (!pairing) {
      throw new Error("Pairing code is invalid, expired, or for another device type");
    }
    const token = randomToken();
    const name = pairing.requestedName;
    const [device] = await tx
      .insert(devices)
      .values({
        name,
        kind: input.kind,
        tokenHash: sha256(token),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error("Failed to create device");
    return { deviceId: device.id, token, name };
  });
}

export async function authenticateDevice(
  token: string | undefined,
): Promise<{ id: string; name: string; kind: DeviceKind } | null> {
  if (!token) return null;
  const [device] = await db
    .select({ id: devices.id, name: devices.name, kind: devices.kind })
    .from(devices)
    .where(and(eq(devices.tokenHash, sha256(token)), isNull(devices.revokedAt)))
    .limit(1);
  if (!device) return null;
  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, device.id));
  return device;
}
