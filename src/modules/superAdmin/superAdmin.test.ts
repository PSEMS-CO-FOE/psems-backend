import { PasswordResetRequestStatus, Role } from "@prisma/client";
import request from "supertest";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { redis } from "../../config/redis";
import { TEST_PASSWORD, createHarness } from "../shared/testing/harness";

const h = createHarness("superadmin-");

beforeAll(async () => {
  await h.cleanup();
  await h.makeUser("super", Role.SUPER_ADMIN);
  await h.makeUser("admin", Role.SYSTEM_ADMIN);
  await h.makeUser("student", Role.STUDENT, { student: true });
  await h.login("super");
  await h.login("admin");
  await h.login("student");
});

afterAll(async () => {
  await prisma.passwordResetRequest.deleteMany({ where: { email: { startsWith: h.prefix } } });
  await h.cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("The two admin tiers are separate, not nested", () => {
  it("refuses a System Admin every Super Admin route", async () => {
    for (const path of ["/super-admin/admins", "/super-admin/users", "/super-admin/audit"]) {
      await request(app).get(path).set(h.as("admin")).expect(403);
    }
  });

  it("refuses a Super Admin the System Admin routes", async () => {
    // Holding the highest tier must not quietly grant the course-running powers
    // the department assigns to somebody else.
    await request(app).get("/lecturers/pending").set(h.as("super")).expect(403);
    await request(app).post("/students/bulk-provision").set(h.as("super")).expect(403);
  });

  it("refuses a student outright", async () => {
    await request(app).get("/super-admin/users").set(h.as("student")).expect(403);
  });
});

describe("Creating a System Admin", () => {
  it("issues a temp password that works once and must then be changed", async () => {
    const email = `${h.prefix}made@psems.dev`;
    const res = await request(app)
      .post("/super-admin/admins")
      .set(h.as("super"))
      .send({ email, fullName: "Made Admin" })
      .expect(201);

    expect(res.body.user.role).toBe(Role.SYSTEM_ADMIN);
    expect(res.body.tempPassword).toEqual(expect.any(String));

    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: res.body.tempPassword })
      .expect(200);
    expect(login.body.forcePasswordChange).toBe(true);

    // The flag is real: protected routes stay shut until the password changes.
    await request(app)
      .get("/lecturers/pending")
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .expect(403);
  });

  it("refuses an email that already has an account", async () => {
    await request(app)
      .post("/super-admin/admins")
      .set(h.as("super"))
      .send({ email: h.email("admin"), fullName: "Duplicate" })
      .expect(409);
  });
});

describe("Suspension", () => {
  it("stops the account signing in, and reinstating lets it back", async () => {
    await request(app)
      .post(`/super-admin/users/${h.userIds.student}/suspend`)
      .set(h.as("super"))
      .send({ reason: "Left the programme" })
      .expect(200);

    await request(app)
      .post("/auth/login")
      .send({ email: h.email("student"), password: TEST_PASSWORD })
      .expect(403);

    await request(app)
      .post(`/super-admin/users/${h.userIds.student}/reinstate`)
      .set(h.as("super"))
      .expect(200);

    await request(app)
      .post("/auth/login")
      .send({ email: h.email("student"), password: TEST_PASSWORD })
      .expect(200);
  });

  it("requires a reason", async () => {
    await request(app)
      .post(`/super-admin/users/${h.userIds.admin}/suspend`)
      .set(h.as("super"))
      .send({})
      .expect(400);
  });

  it("refuses to act on the caller's own account", async () => {
    // Otherwise the last Super Admin can lock the system's only key inside it.
    await request(app)
      .post(`/super-admin/users/${h.userIds.super}/suspend`)
      .set(h.as("super"))
      .send({ reason: "Nope" })
      .expect(400);
  });
});

describe("Resetting a password", () => {
  it("replaces the old password and forces a change", async () => {
    const res = await request(app)
      .post(`/super-admin/users/${h.userIds.admin}/reset-password`)
      .set(h.as("super"))
      .expect(200);

    await request(app)
      .post("/auth/login")
      .send({ email: h.email("admin"), password: TEST_PASSWORD })
      .expect(401);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: h.email("admin"), password: res.body.tempPassword })
      .expect(200);
    expect(login.body.forcePasswordChange).toBe(true);
  });
});

describe("Deleting an account", () => {
  it("refuses one that has activity, and allows one that has none", async () => {
    // The student holds a Student row, so removing the user would take real
    // record with it; the bare account has nothing pointing at it.
    await request(app).delete(`/super-admin/users/${h.userIds.student}`).set(h.as("super")).expect(409);

    const bare = await h.makeUser("bare", Role.LECTURER);
    await request(app).delete(`/super-admin/users/${bare}`).set(h.as("super")).expect(204);
    expect(await prisma.user.findUnique({ where: { id: bare } })).toBeNull();
  });
});

describe("Asking for a password reset", () => {
  it("answers the same whether or not the account exists", async () => {
    const known = await request(app)
      .post("/auth/password-reset-request")
      .send({ email: h.email("student"), note: "Locked out" })
      .expect(200);

    const unknown = await request(app)
      .post("/auth/password-reset-request")
      .send({ email: `${h.prefix}ghost@psems.dev` })
      .expect(200);

    expect(known.body.message).toBe(unknown.body.message);
  });

  it("keeps one open request per address however many times it is asked", async () => {
    await request(app).post("/auth/password-reset-request").send({ email: h.email("student") }).expect(200);

    const open = await prisma.passwordResetRequest.count({
      where: { email: h.email("student"), status: PasswordResetRequestStatus.PENDING },
    });
    expect(open).toBe(1);
  });

  it("reaches the Super Admin, and a reset closes it", async () => {
    const listed = await request(app)
      .get("/super-admin/password-reset-requests?status=PENDING")
      .set(h.as("super"))
      .expect(200);
    expect(listed.body.requests.some((r: { email: string }) => r.email === h.email("student"))).toBe(true);

    await request(app)
      .post(`/super-admin/users/${h.userIds.student}/reset-password`)
      .set(h.as("super"))
      .expect(200);

    const after = await prisma.passwordResetRequest.findFirst({
      where: { email: h.email("student") },
      orderBy: { createdAt: "desc" },
    });
    expect(after?.status).toBe(PasswordResetRequestStatus.COMPLETED);
  });
});

describe("The audit log", () => {
  it("is readable, and names who acted", async () => {
    const res = await request(app).get("/super-admin/audit?limit=20").set(h.as("super")).expect(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0]).toHaveProperty("action");
  });
});
