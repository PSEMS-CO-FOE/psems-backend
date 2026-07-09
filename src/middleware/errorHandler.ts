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

  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
