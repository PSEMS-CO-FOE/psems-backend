import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { Role } from "@prisma/client";

const STUDENT_EMAIL = "week1-test-student@psems.dev";
const STUDENT_TEMP_PASSWORD = "Temp#Passw0rd1";
const STUDENT_NEW_PASSWORD = "NewStrongPass#1";
const ADMIN_EMAIL = "week1-test-admin@psems.dev";
const ADMIN_PASSWORD = "Admin#Pilot2026";

describe("Week 1 acceptance: login + forced first-login password change", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: {
        email: STUDENT_EMAIL,
        passwordHash: await bcrypt.hash(STUDENT_TEMP_PASSWORD, 12),
        role: Role.STUDENT,
        forcePasswordChange: true,
        student: {
          create: { studentId: "WEEK1-TEST-001", department: "Test Dept", year: 1 },
        },
      },
    });

    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
        role: Role.SYSTEM_ADMIN,
        forcePasswordChange: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [STUDENT_EMAIL, ADMIN_EMAIL] } } });
    await prisma.$disconnect();
    await redis.quit();
  });

  it("blocks a provisioned student from other routes until password is changed, then allows access", async () => {
    const loginRes = await request(app)
      .post("/auth/login")
      .send({ email: STUDENT_EMAIL, password: STUDENT_TEMP_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.forcePasswordChange).toBe(true);
    const firstAccessToken = loginRes.body.accessToken as string;

    const blockedRes = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${firstAccessToken}`);
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.code).toBe("FORCE_PASSWORD_CHANGE");

    const changeRes = await request(app)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${firstAccessToken}`)
      .send({ currentPassword: STUDENT_TEMP_PASSWORD, newPassword: STUDENT_NEW_PASSWORD });
    expect(changeRes.status).toBe(200);

    const secondLoginRes = await request(app)
      .post("/auth/login")
      .send({ email: STUDENT_EMAIL, password: STUDENT_NEW_PASSWORD });
    expect(secondLoginRes.status).toBe(200);
    expect(secondLoginRes.body.forcePasswordChange).toBe(false);

    const allowedRes = await request(app)
      .get("/users/me")
      .set("Authorization", `Bearer ${secondLoginRes.body.accessToken}`);
    expect(allowedRes.status).toBe(200);
  });

  it("standard-created accounts (e.g. Admin) are never forced to change password", async () => {
    const loginRes = await request(app)
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.forcePasswordChange).toBe(false);
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    const res = await request(app).get("/users/me");
    expect(res.status).toBe(401);
  });
});
