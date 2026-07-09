import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";

export const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true })); // dev-permissive; locked to prod origin in Week 12 hardening pass
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRouter);
app.use("/users", usersRouter);

app.use(errorHandler);
