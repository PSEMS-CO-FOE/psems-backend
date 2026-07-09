import bcrypt from "bcrypt";
import request from "supertest";
import { Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const ADMIN_EMAIL = "w2jest.lect.admin@psems.dev";
const ADMIN_PASSWORD = "Admin#TestPass1";
const LECT_EMAIL = "w2jest.lect.applicant@psems.dev";
const LECT_PASSWORD = "Lecturer#Pass1";
const REJECT_EMAIL = "w2jest.lect.rejected@psems.dev";
const PREFIX = "w2jest.lect.";

describe("Week 2 acceptance: lecturer self-registration + approval", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
        role: Role.SYSTEM_ADMIN,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
    await emailQueue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  it("walks register → blocked login → approval → successful login", async () => {
    const reg = await request(app)
      .post("/lecturers/register")
      .send({ email: LECT_EMAIL, fullName: "Dr. Test Lecturer", password: LECT_PASSWORD });
    expect(reg.status).toBe(201);
    expect(reg.body.lecturer.approvalStatus).toBe("PENDING");

    // Correct password while PENDING → informative 403 (owner may know).
    const pendingLogin = await request(app)
      .post("/auth/login")
      .send({ email: LECT_EMAIL, password: LECT_PASSWORD });
    expect(pendingLogin.status).toBe(403);

    // Wrong password → generic 401: approval status must not be probeable.
    const wrongPw = await request(app)
      .post("/auth/login")
      .send({ email: LECT_EMAIL, password: "Wrong#Pass123" });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error).toBe("Invalid email or password");

    const adminLogin = await request(app)
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const adminToken = adminLogin.body.accessToken as string;

    const pending = await request(app)
      .get("/lecturers/pending")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(pending.status).toBe(200);
    const entry = pending.body.find((l: { user: { email: string } }) => l.user.email === LECT_EMAIL);
    expect(entry).toBeDefined();

    const approve = await request(app)
      .post(`/lecturers/${entry.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.approvalStatus).toBe("APPROVED");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: LECT_EMAIL, password: LECT_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe(Role.LECTURER);
    expect(login.body.forcePasswordChange).toBe(false);
  });

  it("keeps login blocked after rejection", async () => {
    const reg = await request(app)
      .post("/lecturers/register")
      .send({ email: REJECT_EMAIL, fullName: "Dr. Rejected", password: LECT_PASSWORD });
    expect(reg.status).toBe(201);

    const adminLogin = await request(app)
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const adminToken = adminLogin.body.accessToken as string;

    // Registration returns the lecturer row id — the same id approve/reject take.
    const reject = await request(app)
      .post(`/lecturers/${reg.body.lecturer.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reject.status).toBe(200);
    expect(reject.body.approvalStatus).toBe("REJECTED");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: REJECT_EMAIL, password: LECT_PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error).toContain("rejected");
  });

  it("records registration and approval decisions in the audit log", async () => {
    // Audit inserts are fire-and-forget after the response; poll briefly.
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const row = await prisma.auditLog.findFirst({
        where: { action: "POST /lecturers/register", statusCode: 201 },
        orderBy: { createdAt: "desc" },
      });
      if (row) found = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(found).toBe(true);
  });
});
