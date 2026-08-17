import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
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
    issuer: "AI Conversation Archive",
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
    issuer: "AI Conversation Archive",
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
      and(lt(pairingCodes.expiresAt, new Date()), isNull(pairingCodes.claimedAt)),
    );
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
