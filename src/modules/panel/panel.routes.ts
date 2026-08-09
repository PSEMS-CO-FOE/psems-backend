import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { addPanelistSchema, inviteGuestSchema, joinPanelSchema, updatePanelistSchema } from "./panel.schemas";
import * as panel from "./panel.service";

export const panelRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];

panelRouter.get("/sessions/:sessionId/panel", ...authed, async (req, res, next) => {
  try {
    return res.json(await panel.listPanel(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

panelRouter.post("/sessions/:sessionId/panel", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = addPanelistSchema.parse(req.body);
    return res.status(201).json(await panel.addPanelist(req.user!.user_id, req.params.cpiId, req.params.sessionId, input));
  } catch (err) {
    return next(err);
  }
});

panelRouter.patch("/sessions/:sessionId/panel/:panelistId", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = updatePanelistSchema.parse(req.body);
    return res.json(
      await panel.updatePanelist(req.user!.user_id, req.params.cpiId, req.params.sessionId, req.params.panelistId, input),
    );
  } catch (err) {
    return next(err);
  }
});

panelRouter.delete("/sessions/:sessionId/panel/:panelistId", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(
      await panel.removePanelist(req.user!.user_id, req.params.cpiId, req.params.sessionId, req.params.panelistId),
    );
  } catch (err) {
    return next(err);
  }
});

// A lecturer joining an open evaluation themselves — the demo-day case, where
// nobody is assigned and whoever attends may mark.
panelRouter.post(
  "/sessions/:sessionId/panel/join",
  ...authed,
  requirePhase(CpiPhase.EVALUATION_EXECUTION),
  async (req, res, next) => {
    try {
      const { role } = joinPanelSchema.parse(req.body ?? {});
      return res.status(201).json(await panel.joinOpenPanel(req.user!.user_id, req.params.cpiId, req.params.sessionId, role));
    } catch (err) {
      return next(err);
    }
  },
);

panelRouter.get("/guests", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await panel.listGuests(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// The raw scoring link is returned once, here, and never stored — only its hash
// is kept, so it cannot be read back later.
panelRouter.post("/guests", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = inviteGuestSchema.parse(req.body);
    return res.status(201).json(await panel.inviteGuest(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});

panelRouter.post("/guests/:guestId/revoke", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await panel.revokeGuest(req.user!.user_id, req.params.cpiId, req.params.guestId));
  } catch (err) {
    return next(err);
  }
});
