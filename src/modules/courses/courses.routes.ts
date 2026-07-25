import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import {
  assignEvaluatorSchema,
  createCpiSchema,
  inviteSupervisorSchema,
  respondInviteSchema,
  setHeadJudgeSchema,
  setTimelineSchema,
} from "./courses.schemas";
import * as courses from "./courses.service";

export const coursesRouter = Router();

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];
// Step-3 actions are gated to the SUPERVISOR_ADDITION phase window.
const inSupervisorAddition = requirePhase(CpiPhase.SUPERVISOR_ADDITION);

// --- CPI creation + timeline (not phase-gated: these define the phases) ---

coursesRouter.post("/", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = createCpiSchema.parse(req.body);
    return res.status(201).json(await courses.createCpi(req.user!.user_id, input));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.listOwnedCpis(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

// A lecturer's own pending supervisor invites. Identity-based (not coordinator-
// scoped), and defined BEFORE "/:cpiId" so "supervisor-invites" isn't captured
// as a cpiId. Not phase-gated — a lecturer can view invites at any time.
coursesRouter.get("/supervisor-invites/mine", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.listMySupervisorInvites(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

// CPI discovery so students/lecturers never paste a CPI id. Two segments each,
// defined BEFORE "/:cpiId" so they aren't captured as a cpiId. Identity-based.
coursesRouter.get("/mine/student", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.listStudentCpis(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/mine/lecturer", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.listLecturerCpis(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

// Non-sensitive summary for any authenticated participant (name for headers,
// etc.). Defined before "/:cpiId" so "summary" isn't read as a phase action.
coursesRouter.get("/:cpiId/summary", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.getCpiSummary(req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/:cpiId", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.getCpiDetail(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.put("/:cpiId/timeline", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = setTimelineSchema.parse(req.body);
    return res.json(await courses.setTimeline(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});

// --- Step 3: supervisor addition (mode determination) ---

coursesRouter.post("/:cpiId/supervisors", ...coordinatorOnly, inSupervisorAddition, async (req, res, next) => {
  try {
    const { lecturerUserId } = inviteSupervisorSchema.parse(req.body);
    return res.status(201).json(await courses.inviteSupervisor(req.user!.user_id, req.params.cpiId, lecturerUserId));
  } catch (err) {
    return next(err);
  }
});

// Identity-based auth (any authenticated user with a matching invite); the
// service verifies the invite belongs to the caller, so no requireRole here.
coursesRouter.post("/:cpiId/supervisors/respond", ...authed, inSupervisorAddition, async (req, res, next) => {
  try {
    const { decision } = respondInviteSchema.parse(req.body);
    return res.json(await courses.respondToSupervisorInvite(req.user!.user_id, req.params.cpiId, decision));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.post(
  "/:cpiId/finalize-coordinator-managed",
  ...coordinatorOnly,
  inSupervisorAddition,
  async (req, res, next) => {
    try {
      return res.json(await courses.finalizeCoordinatorManaged(req.user!.user_id, req.params.cpiId));
    } catch (err) {
      return next(err);
    }
  },
);

// --- Step 3: evaluator + Head Judge assignment (both modes) ---

coursesRouter.post("/:cpiId/evaluators", ...coordinatorOnly, inSupervisorAddition, async (req, res, next) => {
  try {
    const { lecturerUserId } = assignEvaluatorSchema.parse(req.body);
    return res.status(201).json(await courses.assignEvaluator(req.user!.user_id, req.params.cpiId, lecturerUserId));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.post("/:cpiId/head-judge", ...coordinatorOnly, inSupervisorAddition, async (req, res, next) => {
  try {
    const { lecturerUserId } = setHeadJudgeSchema.parse(req.body);
    return res.json(await courses.setHeadJudge(req.user!.user_id, req.params.cpiId, lecturerUserId));
  } catch (err) {
    return next(err);
  }
});
