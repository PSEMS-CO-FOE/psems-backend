import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { postIdeaSchema, requestRevisionSchema } from "./ideas.schemas";
import * as ideas from "./ideas.service";

export const ideasRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const inIdeaAnnouncement = requirePhase(CpiPhase.IDEA_ANNOUNCEMENT);

// Posting is open to several actor types (supervisor/coordinator/student); the
// service authorizes by capacity, so no requireRole here — just phase-gate it.
ideasRouter.post("/", ...authed, inIdeaAnnouncement, async (req, res, next) => {
  try {
    const { title, description } = postIdeaSchema.parse(req.body);
    return res.status(201).json(await ideas.postIdea(req.user!.user_id, req.params.cpiId, title, description));
  } catch (err) {
    return next(err);
  }
});

// Listing is not phase-gated (reads); visibility is enforced in the service.
ideasRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await ideas.listIdeas(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// A student edits and resubmits their group's idea (author check in service).
ideasRouter.patch("/:ideaId", ...authed, inIdeaAnnouncement, async (req, res, next) => {
  try {
    const { title, description } = postIdeaSchema.parse(req.body);
    return res.json(await ideas.updateIdea(req.user!.user_id, req.params.cpiId, req.params.ideaId, title, description));
  } catch (err) {
    return next(err);
  }
});

// Coordinator or supervisor asks the group to revise (authorized in service).
ideasRouter.post("/:ideaId/request-revision", ...authed, inIdeaAnnouncement, async (req, res, next) => {
  try {
    const { note } = requestRevisionSchema.parse(req.body);
    return res.json(await ideas.requestIdeaRevision(req.user!.user_id, req.params.cpiId, req.params.ideaId, note));
  } catch (err) {
    return next(err);
  }
});

const coordinatorInPhase = [...authed, requireRole(Role.COURSE_COORDINATOR), inIdeaAnnouncement];

ideasRouter.post("/:ideaId/approve", ...coordinatorInPhase, async (req, res, next) => {
  try {
    return res.json(await ideas.decideIdea(req.user!.user_id, req.params.cpiId, req.params.ideaId, "APPROVED"));
  } catch (err) {
    return next(err);
  }
});

ideasRouter.post("/:ideaId/reject", ...coordinatorInPhase, async (req, res, next) => {
  try {
    return res.json(await ideas.decideIdea(req.user!.user_id, req.params.cpiId, req.params.ideaId, "REJECTED"));
  } catch (err) {
    return next(err);
  }
});
