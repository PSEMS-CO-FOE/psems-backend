import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Role } from "@prisma/client";
import { env } from "../../config/env";
import { redis } from "../../config/redis";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface AccessTokenPayload {
  user_id: string;
  role: Role;
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

// Opaque random token stored server-side (Redis) so it can be revoked early —
// a stateless JWT refresh token couldn't be (spec 9.1).
export async function issueRefreshToken(userId: string): Promise<string> {
  const jti = crypto.randomUUID();
  await redis.set(`refresh:${jti}`, userId, "EX", REFRESH_TOKEN_TTL_SECONDS);
  return jti;
}

export async function consumeRefreshToken(jti: string): Promise<string | null> {
  const userId = await redis.get(`refresh:${jti}`);
  if (!userId) return null;
  // Rotation: delete on use so a replayed token only works once.
  await redis.del(`refresh:${jti}`);
  return userId;
}

export async function revokeRefreshToken(jti: string): Promise<void> {
  await redis.del(`refresh:${jti}`);
}

export const REFRESH_COOKIE_NAME = "psems_refresh_token";
export const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;
