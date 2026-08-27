import bcrypt from "bcrypt";
import request from "supertest";
import { Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

// Its own file rather than an extra describe on lecturers.test.ts: that suite's
// afterAll closes Prisma, Redis and the queue, so anything appended after it
// runs against dead connections and hangs.
const PREFIX = "coordrole.";
const ADMIN_EMAIL = `${PREFIX}admin@psems.dev`;
const ADMIN_PASSWORD = "Admin#TestPass1";
const LECT_EMAIL = `${PREFIX}lecturer@psems.dev`;
const LECT_PASSWORD = "Lecturer#Pass1";

async function adminToken() {
  const res = await request(app).post("/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return res.body.accessToken as string;
}

async function lecturerUserId() {
  const user = await prisma.user.findUnique({ where: { email: LECT_EMAIL } });
  return user!.id;
}

describe("Promoting and demoting a Course Coordinator", () => {
  beforeAll(async () => {
    await prisma.courseInstance.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
        role: Role.SYSTEM_ADMIN,
      },
    });
    await request(app)
      .post("/lecturers/register")
      .send({ email: LECT_EMAIL, fullName: "Dr. Promoted", password: LECT_PASSWORD });
    await prisma.lecturer.updateMany({
      where: { user: { email: LECT_EMAIL } },
      data: { approvalStatus: "APPROVED" },
    });
  });

  afterAll(async () => {
    await prisma.courseInstance.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
    await emailQueue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  it("promotes, then removes the role again, leaving the lecturer record intact", async () => {
    const token = await adminToken();
    const id = await lecturerUserId();

    const up = await request(app).post(`/users/${id}/assign-coordinator`).set("Authorization", `Bearer ${token}`);
    expect(up.status).toBe(200);
    expect(up.body.role).toBe("COURSE_COORDINATOR");

    const down = await request(app).post(`/users/${id}/revoke-coordinator`).set("Authorization", `Bearer ${token}`);
    expect(down.status).toBe(200);
    expect(down.body.role).toBe("LECTURER");

    // Nothing they supervise hangs off User.role, so demotion must not touch it.
    const after = await prisma.user.findUnique({ where: { id }, include: { lecturer: true } });
    expect(after!.lecturer).not.toBeNull();
    expect(after!.lecturer!.approvalStatus).toBe("APPROVED");
  });

  it("refuses to remove the role while they still coordinate a course", async () => {
    const token = await adminToken();
    const id = await lecturerUserId();

    await request(app).post(`/users/${id}/assign-coordinator`).set("Authorization", `Bearer ${token}`).expect(200);
    await prisma.courseInstance.create({
      data: {
        name: `${PREFIX}Course`,
        projectType: "FYP",
        participationMode: "GROUP",
        department: "CE",
        batch: "22ENG",
        academicYear: "2026",
        createdById: id,
      },
    });

    const blocked = await request(app).post(`/users/${id}/revoke-coordinator`).set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(409);

    const still = await prisma.user.findUnique({ where: { id } });
    expect(still!.role).toBe("COURSE_COORDINATOR");
  });
});
