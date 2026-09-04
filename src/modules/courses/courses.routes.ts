import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import {
  applyPresetSchema,
  assignEvaluatorSchema,
  createCpiSchema,
  addStudentSchema,
  decideJoinRequestSchema,
  decideSupervisorRequestSchema,
  joinRequestSchema,
  inviteSupervisorSchema,
  requestToSuperviseSchema,
  respondInviteSchema,
  setCourseStatusSchema,
  setHeadJudgeSchema,
  setTimelineSchema,
} from "./courses.schemas";
import * as courses from "./courses.service";
import * as joinRequests from "./joinRequests.service";

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

// Discovery: any approved lecturer can find courses and ask to join one.
// Deliberately mounted before the /:cpiId routes so "open" is not read as an id.
// The batches this department already uses, so the create form can suggest them
// rather than relying on the same code being typed the same way twice.
coursesRouter.get("/batches", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.listDepartmentBatches(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

// Active courses in the student's department for OTHER batches — name and batch
// only, never contents — so a repeated student can name the one they want.
coursesRouter.get("/other-batches", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.listOtherBatchCpis(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/open", ...authed, async (req, res, next) => {
  try {
    return res.json(await courses.listOpenCpis(req.user!.user_id));
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

coursesRouter.post("/:cpiId/status", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { status } = setCourseStatusSchema.parse(req.body);
    return res.json(await courses.setCourseStatus(req.user!.user_id, req.params.cpiId, status));
  } catch (err) {
    return next(err);
  }
});

// Everyone the course is for, and what each of them is doing.
coursesRouter.get("/:cpiId/roster", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.getCourseRoster(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// A repeated student asking to take this course with a later batch. Not
// phase-gated: the request is made after their own course has finished.
coursesRouter.post("/:cpiId/join-requests", ...authed, async (req, res, next) => {
  try {
    const { reason } = joinRequestSchema.parse(req.body);
    return res.status(201).json(await joinRequests.requestToJoin(req.user!.user_id, req.params.cpiId, reason));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/:cpiId/join-requests", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await joinRequests.listJoinRequests(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// Students this course could take on, for the coordinator's picker. Before
// this the request had to come from the student, so a repeated student who did
// not know to ask could not be enrolled at all.
coursesRouter.get("/:cpiId/addable-students", ...coordinatorOnly, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    return res.json(await joinRequests.listAddableStudents(req.user!.user_id, req.params.cpiId, q || undefined));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.post("/:cpiId/added-students", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { studentId, note } = addStudentSchema.parse(req.body);
    return res
      .status(201)
      .json(await joinRequests.addStudent(req.user!.user_id, req.params.cpiId, studentId, note));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.post("/:cpiId/join-requests/:requestId", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { approve, note } = decideJoinRequestSchema.parse(req.body);
    return res.json(
      await joinRequests.decideJoinRequest(
        req.user!.user_id,
        req.params.cpiId,
        req.params.requestId,
        approve,
        note,
      ),
    );
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

coursesRouter.post("/:cpiId/supervisor-requests", ...authed, async (req, res, next) => {
  try {
    const { note } = requestToSuperviseSchema.parse(req.body ?? {});
    return res.status(201).json(await courses.requestToSupervise(req.user!.user_id, req.params.cpiId, note));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.get("/:cpiId/supervisor-requests", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.listSupervisorRequests(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

coursesRouter.post("/:cpiId/supervisor-requests/:requestId", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { decision } = decideSupervisorRequestSchema.parse(req.body);
    return res.json(
      await courses.decideSupervisorRequest(req.user!.user_id, req.params.cpiId, req.params.requestId, decision),
    );
  } catch (err) {
    return next(err);
  }
});

// Applies a named preset. Not phase-gated: it only seeds policy defaults, and a
// coordinator may reach for one at any point.
coursesRouter.post("/:cpiId/preset", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { mode } = applyPresetSchema.parse(req.body);
    return res.json(await courses.applyPreset(req.user!.user_id, req.params.cpiId, mode));
  } catch (err) {
    return next(err);
  }
});

// The original single-preset route, kept so existing links do not break.
coursesRouter.post("/:cpiId/coordinator-managed-preset", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await courses.applyCoordinatorManagedPreset(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

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
