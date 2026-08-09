import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { auditLogger } from "./middleware/audit";
import { errorHandler } from "./middleware/errorHandler";
import { allocationRouter } from "./modules/allocation/allocation.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { coursesRouter } from "./modules/courses/courses.routes";
import { evaluationsRouter } from "./modules/evaluations/evaluations.routes";
import { filesRouter } from "./modules/files/files.routes";
import { groupsRouter } from "./modules/groups/groups.routes";
import { ideasRouter } from "./modules/ideas/ideas.routes";
import { lecturersRouter } from "./modules/lecturers/lecturers.routes";
import { marksRouter } from "./modules/marks/marks.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { guestRouter } from "./modules/panel/guest.routes";
import { panelRouter } from "./modules/panel/panel.routes";
import { policyRouter } from "./modules/policy/policy.routes";
import { reviewRouter } from "./modules/review/review.routes";
import { schedulingRouter } from "./modules/scheduling/scheduling.routes";
import { scoringRouter } from "./modules/scoring/scoring.routes";
import { selectionRouter } from "./modules/selection/selection.routes";
import { studentsRouter } from "./modules/students/students.routes";
import { usersRouter } from "./modules/users/users.routes";

export const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true })); // dev-permissive; locked to prod origin in Week 12 hardening pass
app.use(express.json());
app.use(cookieParser());
app.use(auditLogger); // after body parsing (needs req.body to hash), before all routes

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/students", studentsRouter);
app.use("/lecturers", lecturersRouter);
app.use("/notifications", notificationsRouter);
// Unauthenticated by design: a guest's one-time link is the credential, and it
// grants nothing beyond scoring the sessions it names.
app.use("/guest", guestRouter);
app.use("/courses", coursesRouter);
app.use("/courses/:cpiId/policy", policyRouter);
app.use("/courses/:cpiId/groups", groupsRouter);
app.use("/courses/:cpiId/ideas", ideasRouter);
app.use("/courses/:cpiId/selection", selectionRouter);
app.use("/courses/:cpiId/allocations", allocationRouter);
app.use("/courses/:cpiId/evaluations", evaluationsRouter);
app.use("/courses/:cpiId/marks", marksRouter);
app.use("/courses/:cpiId", filesRouter);
app.use("/courses/:cpiId", schedulingRouter);
app.use("/courses/:cpiId", scoringRouter);
app.use("/courses/:cpiId", panelRouter);
app.use("/courses/:cpiId", reviewRouter);

app.use(errorHandler);
