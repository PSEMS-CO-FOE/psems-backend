import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { searchProfilesSchema, updateProfileSchema } from "./profiles.schemas";
import * as profiles from "./profiles.service";

export const profilesRouter = Router();

const authed = [requireAuth, blockIfPasswordChangeRequired];

// An institution-wide directory: any logged-in user may read any profile.
// Guests scoring by magic link hold no account and never reach these routes.
profilesRouter.get("/areas", ...authed, async (_req, res, next) => {
  try {
    return res.json(await profiles.listResearchAreas());
  } catch (err) {
    return next(err);
  }
});

profilesRouter.get("/search", ...authed, async (req, res, next) => {
  try {
    const query = searchProfilesSchema.parse(req.query);
    return res.json(await profiles.searchProfiles(query));
  } catch (err) {
    return next(err);
  }
});

profilesRouter.get("/me", ...authed, async (req, res, next) => {
  try {
    return res.json(await profiles.getProfile(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

profilesRouter.patch("/me", ...authed, async (req, res, next) => {
  try {
    const input = updateProfileSchema.parse(req.body);
    return res.json(await profiles.updateMyProfile(req.user!.user_id, input));
  } catch (err) {
    return next(err);
  }
});

// Defined last so "areas", "search" and "me" are not read as user ids.
profilesRouter.get("/:userId", ...authed, async (req, res, next) => {
  try {
    return res.json(await profiles.getProfile(req.params.userId));
  } catch (err) {
    return next(err);
  }
});
