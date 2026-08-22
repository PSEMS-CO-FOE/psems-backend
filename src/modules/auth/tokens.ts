import jwt from "jsonwebtoken";
import crypto from "crypto";
import type { CookieOptions } from "express";
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

// Same-site by default: the SPA and the API are served from one registrable
// domain. COOKIE_SAMESITE=none is for deployments split across unrelated hosts
// (*.vercel.app + *.onrender.com are cross-site by design) — that also makes the
// cookie third-party, which Safari blocks outright. No `domain`, so the cookie
// stays host-only to the API. maxAge is deliberately absent: clearCookie merges
// these options over its own epoch `expires`, and a maxAge would push the expiry
// back into the future, silently re-issuing the cookie instead of clearing it.
export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: env.COOKIE_SAMESITE ?? "strict",
  path: "/",
};
