import { Prisma } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AuthError } from "../modules/auth/auth.service";

// Express only recognizes a 4-arg function as error-handling middleware, so
// req/next must stay in the signature even though this handler doesn't use them.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.flatten().fieldErrors });
  }

  if (err instanceof AuthError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Database contention is a conflict, not a server fault. Without this a
  // constraint doing its job — two supervisors racing to accept the same group —
  // surfaced to the user as "Internal server error".
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "That change conflicts with something already saved — reload and try again",
        code: "UNIQUE_CONFLICT",
      });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "The record this action needs no longer exists", code: "NOT_FOUND" });
    }
  }

  // Raised when two serializable transactions touch the same rows; the loser
  // should retry rather than be told the server broke.
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034")
  ) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("could not serialize") || message.includes("deadlock") || message.includes("P2034")) {
      return res.status(409).json({
        error: "Someone else changed this at the same moment — try again",
        code: "WRITE_CONFLICT",
      });
    }
  }

  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
