import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../../app";
import { prisma } from "../../../config/database";

// Shared integration-test harness. Every suite used to carry its own copy of
// this block; they are isolated from each other by their email prefix, not by
// separate databases, so each suite creates a harness with its own prefix.

export const TEST_PASSWORD = "TestPass#123";

export const PHASE_ORDER: CpiPhase[] = [
  CpiPhase.STUDENT_REGISTRATION,
  CpiPhase.SUPERVISOR_ADDITION,
  CpiPhase.IDEA_ANNOUNCEMENT,
  CpiPhase.PROJECT_SELECTION,
  CpiPhase.PROJECT_REGISTRATION,
  CpiPhase.EVALUATION_CONFIG,
  CpiPhase.PROPOSAL_SUBMISSION,
  CpiPhase.AVAILABILITY_SUBMISSION,
  CpiPhase.EVALUATION_EXECUTION,
  CpiPhase.FINAL_SUBMISSION,
];

// A full timeline positioned so `openPhase` is the one currently open. Phases
// are sequential actions, so a test advances a CPI by re-anchoring the whole
// timeline rather than waiting.
export function timelineOpening(openPhase: CpiPhase) {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const k = PHASE_ORDER.indexOf(openPhase);
  const base = Date.now() - hour - k * day;
  return {
    phases: PHASE_ORDER.map((phase, i) => ({
      phase,
      startDate: new Date(base + i * day).toISOString(),
      endDate: new Date(base + i * day + day).toISOString(),
    })),
  };
}

export interface MakeUserOptions {
  student?: boolean;
  approvedLecturer?: boolean;
  department?: string;
  batch?: string;
}

export function createHarness(prefix: string) {
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  const email = (key: string) => `${prefix}${key}@psems.dev`;

  async function makeUser(key: string, role: Role, opts: MakeUserOptions = {}) {
    const user = await prisma.user.create({
      data: {
        email: email(key),
        fullName: key,
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 12),
        role,
        ...(opts.student
          ? {
              student: {
                create: {
                  studentId: `${prefix}${key}`,
                  batch: opts.batch ?? "22ENG",
                  department: opts.department ?? "CE",
                  year: 3,
                },
              },
            }
          : {}),
        ...(opts.approvedLecturer ? { lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } } } : {}),
      },
    });
    userIds[key] = user.id;
    return user.id;
  }

  async function login(key: string) {
    const res = await request(app).post("/auth/login").send({ email: email(key), password: TEST_PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status} ${JSON.stringify(res.body)}`);
    tokens[key] = res.body.accessToken;
  }

  const as = (key: string) => ({ Authorization: `Bearer ${tokens[key]}` });

  async function openPhase(cpiId: string, phase: CpiPhase) {
    await request(app).put(`/courses/${cpiId}/timeline`).set(as("coord")).send(timelineOpening(phase)).expect(200);
  }

  // Deleting the CPIs first lets their cascades clear sessions, panels and
  // scores before the users those rows point at go.
  async function cleanup() {
    await prisma.courseInstance.deleteMany({ where: { createdBy: { email: { startsWith: prefix } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  }

  return { prefix, email, tokens, userIds, makeUser, login, as, openPhase, cleanup };
}

export type Harness = ReturnType<typeof createHarness>;
