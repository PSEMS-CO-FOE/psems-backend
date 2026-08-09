import { Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import { updatePolicySchema } from "./policy.schemas";
import * as policy from "./policy.service";

export const policyRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];

// Not phase-gated: the policy defines how the phases behave, so it has to be
// editable outside them — the same reasoning as the timeline endpoint.
policyRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await policy.getPolicy(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

policyRouter.patch("/", ...authed, requireRole(Role.COURSE_COORDINATOR), async (req, res, next) => {
  try {
    const input = updatePolicySchema.parse(req.body);
    return res.json(await policy.updatePolicy(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});
