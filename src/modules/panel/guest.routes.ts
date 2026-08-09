import { Router } from "express";
import { z } from "zod";
import { guestScoreSchema } from "./panel.schemas";
import * as guest from "./guest.service";

// Guest scoring is authenticated by the one-time link alone
export const guestRouter = Router();

const tokenQuerySchema = z.object({ token: z.string().min(1) });

guestRouter.get("/workspace", async (req, res, next) => {
  try {
    const { token } = tokenQuerySchema.parse(req.query);
    return res.json(await guest.getGuestWorkspace(token));
  } catch (err) {
    return next(err);
  }
});

guestRouter.post("/scores", async (req, res, next) => {
  try {
    const { token, sessionId, ...input } = guestScoreSchema.parse(req.body);
    return res.status(201).json(await guest.submitGuestScores(token, sessionId, input));
  } catch (err) {
    return next(err);
  }
});
