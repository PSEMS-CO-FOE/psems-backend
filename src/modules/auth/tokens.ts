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

// Refresh tokens are opaque random strings, not JWTs — the server holds the
// only copy (in Redis, keyed by jti) so it can revoke/rotate on use or logout.
// This is what makes the Redis blacklist-on-logout requirement (spec 9.1)
// meaningful: a stateless JWT refresh token couldn't be invalidated early.
export async function issueRefreshToken(userId: string): Promise<string> {
  const jti = crypto.randomUUID();
  await redis.set(`refresh:${jti}`, userId, "EX", REFRESH_TOKEN_TTL_SECONDS);
  return jti;
}

export async function consumeRefreshToken(jti: string): Promise<string | null> {
  const userId = await redis.get(`refresh:${jti}`);
  if (!userId) return null;
  // Rotation: the old token is deleted the moment it's used, whether for a
  // refresh or a logout, so a stolen/replayed token only works once.
  await redis.del(`refresh:${jti}`);
  return userId;
}

export async function revokeRefreshToken(jti: string): Promise<void> {
  await redis.del(`refresh:${jti}`);
}

export const REFRESH_COOKIE_NAME = "psems_refresh_token";
export const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;
