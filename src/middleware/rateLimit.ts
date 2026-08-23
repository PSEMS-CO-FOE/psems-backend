import type { RequestHandler } from "express";
import rateLimit, { type Options } from "express-rate-limit";

const passthrough: RequestHandler = (_req, _res, next) => next();

// Not constructed under test: the memory store's cleanup timer stops Jest exiting.
function limiter(options: Partial<Options>): RequestHandler {
  if (process.env.NODE_ENV === "test") return passthrough;
  return rateLimit({ standardHeaders: true, legacyHeaders: false, ...options });
}

// Failures only, so repeated legitimate sign-ins from a shared address don't lock out.
export const loginRateLimit = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: "Too many sign-in attempts. Wait a few minutes and try again." },
});

// Unauthenticated endpoints that create a row for anyone who asks.
export const accountRequestRateLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: "Too many requests from this address. Try again later." },
});
