import { PasswordResetRequestStatus, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import {
  auditQuerySchema,
  createSystemAdminSchema,
  suspendUserSchema,
  userSearchSchema,
} from "./superAdmin.schemas";
import * as superAdmin from "./superAdmin.service";

export const superAdminRouter = Router();

// The two tiers are separate, not nested: a Super Admin manages accounts and
// holds none of the course powers.
const superAdminOnly = [requireAuth, blockIfPasswordChangeRequired, requireRole(Role.SUPER_ADMIN)];

superAdminRouter.get("/admins", ...superAdminOnly, async (_req, res, next) => {
  try {
    return res.json({ admins: await superAdmin.listSystemAdmins() });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.post("/admins", ...superAdminOnly, async (req, res, next) => {
  try {
    const input = createSystemAdminSchema.parse(req.body);
    const result = await superAdmin.createSystemAdmin(input);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.get("/users", ...superAdminOnly, async (req, res, next) => {
  try {
    const input = userSearchSchema.parse(req.query);
    return res.json({ users: await superAdmin.searchUsers(input) });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.post("/users/:userId/suspend", ...superAdminOnly, async (req, res, next) => {
  try {
    const { reason } = suspendUserSchema.parse(req.body);
    const user = await superAdmin.suspendUser(req.user!.user_id, req.params.userId, reason);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.post("/users/:userId/reinstate", ...superAdminOnly, async (req, res, next) => {
  try {
    const user = await superAdmin.reinstateUser(req.user!.user_id, req.params.userId);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.post("/users/:userId/reset-password", ...superAdminOnly, async (req, res, next) => {
  try {
    return res.json(await superAdmin.resetPassword(req.user!.user_id, req.params.userId));
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.delete("/users/:userId", ...superAdminOnly, async (req, res, next) => {
  try {
    await superAdmin.deleteUser(req.user!.user_id, req.params.userId);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.get("/audit", ...superAdminOnly, async (req, res, next) => {
  try {
    const input = auditQuerySchema.parse(req.query);
    return res.json({ entries: await superAdmin.readAuditLog(input) });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.get("/password-reset-requests", ...superAdminOnly, async (req, res, next) => {
  try {
    const status = req.query.status as PasswordResetRequestStatus | undefined;
    const valid = status && Object.values(PasswordResetRequestStatus).includes(status) ? status : undefined;
    return res.json({ requests: await superAdmin.listPasswordResetRequests(valid) });
  } catch (err) {
    return next(err);
  }
});

superAdminRouter.post("/password-reset-requests/:requestId/dismiss", ...superAdminOnly, async (req, res, next) => {
  try {
    await superAdmin.dismissPasswordResetRequest(req.user!.user_id, req.params.requestId);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});
