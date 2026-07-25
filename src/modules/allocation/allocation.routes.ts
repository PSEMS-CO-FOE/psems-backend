import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { overrideAllocationSchema } from "./allocation.schemas";
import * as allocation from "./allocation.service";

export const allocationRouter = Router({ mergeParams: true });

const coordinatorOnly = [requireAuth, blockIfPasswordChangeRequired, requireRole(Role.COURSE_COORDINATOR)];
const inRegistration = requirePhase(CpiPhase.PROJECT_REGISTRATION);

allocationRouter.get("/", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await allocation.getAllocationMap(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

allocationRouter.post("/generate", ...coordinatorOnly, inRegistration, async (req, res, next) => {
  try {
    return res.status(201).json(await allocation.generateAllocations(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

allocationRouter.put("/:groupId", ...coordinatorOnly, inRegistration, async (req, res, next) => {
  try {
    const { ideaId, supervisorUserId } = overrideAllocationSchema.parse(req.body);
    return res.json(
      await allocation.overrideAllocation(req.user!.user_id, req.params.cpiId, req.params.groupId, ideaId, supervisorUserId),
    );
  } catch (err) {
    return next(err);
  }
});

// Coordinator-Managed only: mark a pairing reviewed/confirmed (spec Step 7).
allocationRouter.post("/:groupId/confirm", ...coordinatorOnly, inRegistration, async (req, res, next) => {
  try {
    return res.json(await allocation.confirmAllocation(req.user!.user_id, req.params.cpiId, req.params.groupId));
  } catch (err) {
    return next(err);
  }
});

allocationRouter.post("/finalize", ...coordinatorOnly, inRegistration, async (req, res, next) => {
  try {
    return res.json(await allocation.finalizeAllocations(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
