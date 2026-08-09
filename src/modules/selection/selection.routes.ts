import { CpiPhase } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import {
  ideaRefSchema,
  respondSelectionSchema,
  selectProjectSchema,
  withdrawInterestSchema,
} from "./selection.schemas";
import * as selection from "./selection.service";

export const selectionRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const inSelection = requirePhase(CpiPhase.PROJECT_SELECTION);

// Every mutation is gated to PROJECT_SELECTION; the service authorizes by
// capacity (group leader / supervisor / coordinator) since actors differ.

selectionRouter.post("/interest", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId } = ideaRefSchema.parse(req.body);
    return res.status(201).json(await selection.expressInterest(req.user!.user_id, req.params.cpiId, ideaId));
  } catch (err) {
    return next(err);
  }
});

// The mirror image of a group expressing interest: a lecturer says they would
// like to take on a group's idea.
selectionRouter.post("/lecturer-interest", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId } = ideaRefSchema.parse(req.body);
    return res
      .status(201)
      .json(await selection.expressLecturerInterest(req.user!.user_id, req.params.cpiId, ideaId));
  } catch (err) {
    return next(err);
  }
});

selectionRouter.post("/co-supervision-interest", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId } = ideaRefSchema.parse(req.body);
    return res
      .status(201)
      .json(await selection.expressCoSupervisionInterest(req.user!.user_id, req.params.cpiId, ideaId));
  } catch (err) {
    return next(err);
  }
});

// Withdrawal is gated to the phase like every other EOI action, so interest
// freezes when selection closes.
selectionRouter.delete("/interest/:ideaId", ...authed, inSelection, async (req, res, next) => {
  try {
    const { type } = withdrawInterestSchema.parse(req.query);
    return res.json(await selection.withdrawInterest(req.user!.user_id, req.params.cpiId, req.params.ideaId, type));
  } catch (err) {
    return next(err);
  }
});

selectionRouter.post("/seeking-supervisor", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId } = ideaRefSchema.parse(req.body);
    return res.status(201).json(await selection.markSeekingSupervisor(req.user!.user_id, req.params.cpiId, ideaId));
  } catch (err) {
    return next(err);
  }
});

selectionRouter.post("/willing", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId } = ideaRefSchema.parse(req.body);
    return res.status(201).json(await selection.markWilling(req.user!.user_id, req.params.cpiId, ideaId));
  } catch (err) {
    return next(err);
  }
});

selectionRouter.post("/select", ...authed, inSelection, async (req, res, next) => {
  try {
    const { ideaId, supervisorUserId } = selectProjectSchema.parse(req.body);
    return res
      .status(201)
      .json(await selection.selectProject(req.user!.user_id, req.params.cpiId, ideaId, supervisorUserId));
  } catch (err) {
    return next(err);
  }
});

selectionRouter.post("/:selectionId/respond", ...authed, inSelection, async (req, res, next) => {
  try {
    const { decision } = respondSelectionSchema.parse(req.body);
    return res.json(
      await selection.respondToSelection(req.user!.user_id, req.params.cpiId, req.params.selectionId, decision),
    );
  } catch (err) {
    return next(err);
  }
});

// Read-only state view — not phase-gated.
selectionRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await selection.getSelectionState(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
