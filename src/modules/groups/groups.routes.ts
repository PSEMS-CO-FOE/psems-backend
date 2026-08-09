import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { createGroupSchema, inviteMemberSchema, respondGroupInviteSchema } from "./groups.schemas";
import * as groups from "./groups.service";

// mergeParams so :cpiId from the mount path is visible to handlers + phase gate.
export const groupsRouter = Router({ mergeParams: true });

const studentAuthed = [requireAuth, blockIfPasswordChangeRequired, requireRole(Role.STUDENT)];
const inRegistration = requirePhase(CpiPhase.STUDENT_REGISTRATION);

// Group mutations are gated to STUDENT_REGISTRATION; once it closes, groups lock.

groupsRouter.post("/", ...studentAuthed, inRegistration, async (req, res, next) => {
  try {
    const { name } = createGroupSchema.parse(req.body);
    return res.status(201).json(await groups.createGroup(req.user!.user_id, req.params.cpiId, name));
  } catch (err) {
    return next(err);
  }
});

groupsRouter.post("/:groupId/invite", ...studentAuthed, inRegistration, async (req, res, next) => {
  try {
    const { email } = inviteMemberSchema.parse(req.body);
    return res
      .status(201)
      .json(await groups.inviteMember(req.user!.user_id, req.params.cpiId, req.params.groupId, email));
  } catch (err) {
    return next(err);
  }
});

groupsRouter.post("/:groupId/respond", ...studentAuthed, inRegistration, async (req, res, next) => {
  try {
    const { decision } = respondGroupInviteSchema.parse(req.body);
    return res.json(await groups.respondToInvite(req.user!.user_id, req.params.cpiId, req.params.groupId, decision));
  } catch (err) {
    return next(err);
  }
});

// Reads are not phase-gated. /mine and /invites must precede /:groupId so they
// aren't captured as a groupId.
// A student taking part alone: creates their group of one, or returns it if it
// already exists. Idempotent, so the UI can simply call it.
groupsRouter.post("/solo", ...studentAuthed, inRegistration, async (req, res, next) => {
  try {
    return res.status(201).json(await groups.ensureSoloGroup(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

groupsRouter.get("/mine", ...studentAuthed, async (req, res, next) => {
  try {
    return res.json(await groups.getMyGroup(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

groupsRouter.get("/invites", ...studentAuthed, async (req, res, next) => {
  try {
    return res.json(await groups.listMyPendingInvites(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

groupsRouter.get("/:groupId", requireAuth, blockIfPasswordChangeRequired, async (req, res, next) => {
  try {
    return res.json(await groups.getGroup(req.user!.user_id, req.params.cpiId, req.params.groupId));
  } catch (err) {
    return next(err);
  }
});
