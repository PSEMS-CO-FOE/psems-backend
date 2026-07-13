import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { auditLogger } from "./middleware/audit";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/auth.routes";
import { coursesRouter } from "./modules/courses/courses.routes";
import { groupsRouter } from "./modules/groups/groups.routes";
import { ideasRouter } from "./modules/ideas/ideas.routes";
import { lecturersRouter } from "./modules/lecturers/lecturers.routes";
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
app.use("/courses", coursesRouter);
app.use("/courses/:cpiId/groups", groupsRouter);
app.use("/courses/:cpiId/ideas", ideasRouter);

app.use(errorHandler);
