import bcrypt from "bcrypt";
import request from "supertest";
import { Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const ADMIN_EMAIL = "w2jest.prov.admin@psems.dev";
const ADMIN_PASSWORD = "Admin#TestPass1";
const NON_ADMIN_EMAIL = "w2jest.prov.student@psems.dev";
const NON_ADMIN_PASSWORD = "Student#Pass123";
const PREFIX = "w2jest.prov.";

async function loginToken(email: string, password: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

describe("Week 2 acceptance: student bulk provisioning", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    const [adminHash, studentHash] = await Promise.all([
      bcrypt.hash(ADMIN_PASSWORD, 12),
      bcrypt.hash(NON_ADMIN_PASSWORD, 12),
    ]);
    await prisma.user.create({
      data: { email: ADMIN_EMAIL, passwordHash: adminHash, role: Role.SYSTEM_ADMIN },
    });
    // Non-admin with forcePasswordChange false so the 403 we assert comes from
    // requireRole specifically, not the password-change gate.
    await prisma.user.create({
      data: { email: NON_ADMIN_EMAIL, passwordHash: studentHash, role: Role.STUDENT },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
    await emailQueue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  it("provisions valid rows, reports invalid/duplicate rows, queues credential emails", async () => {
    const csv = [
      "email,fullName,studentIndex,registrationNumber,batch,department",
      `${PREFIX}s1@psems.dev,Test One,W2J001,,22ENG,Computer Engineering`,
      `${PREFIX}s2@psems.dev,Test Two,W2J002,,22ENG,Computer Engineering`,
      `${PREFIX}s3@psems.dev,Test Three,W2J003,,22ENG,Computer Engineering`,
      "not-an-email,Broken Row,W2J004,,22ENG,Computer Engineering", // invalid
      `${PREFIX}s1@psems.dev,Dup In File,W2J005,,22ENG,Computer Engineering`, // duplicate within file
      `${ADMIN_EMAIL},Already Exists,W2J006,,22ENG,Computer Engineering`, // existing account
    ].join("\n");

    const token = await loginToken(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .post("/students/bulk-provision")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(csv), "students.csv");

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(res.body.invalid).toHaveLength(1);
    expect(res.body.invalid[0].row).toBe(5);
    expect(res.body.skipped).toHaveLength(2);

    // Provisioned accounts must be gated behind the forced password change.
    const created = await prisma.user.findMany({
      where: { email: { in: [`${PREFIX}s1@psems.dev`, `${PREFIX}s2@psems.dev`, `${PREFIX}s3@psems.dev`] } },
      include: { student: true, provisioningLogs: true },
    });
    expect(created).toHaveLength(3);
    for (const user of created) {
      expect(user.role).toBe(Role.STUDENT);
      expect(user.forcePasswordChange).toBe(true);
      expect(user.student).not.toBeNull();
      expect(user.provisioningLogs).toHaveLength(1);
      expect(user.provisioningLogs[0].batchId).toBe(res.body.batchId);
    }

    // Batch status endpoint aggregates delivery state (QUEUED immediately, or
    // SENT if a worker is running against this Redis).
    const statusRes = await request(app)
      .get(`/students/provisioning/${res.body.batchId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.total).toBe(3);
  });

  // A file whose header ends CRLF and whose rows end LF used to be read as one
  // giant record, and surfaced as an internal error.
  it("reads a file with mixed line endings", async () => {
    const csv =
      "email,fullName,studentIndex,registrationNumber,batch,department\r\n" +
      `${PREFIX}mix1@psems.dev,Mixed One,W2J910,,22ENG,Computer Engineering\n` +
      `${PREFIX}mix2@psems.dev,Mixed Two,W2J911,,22ENG,Computer Engineering\n`;

    const token = await loginToken(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .post("/students/bulk-provision")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(csv), "students.csv");

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
  });

  it("rejects an unreadable file with 400 rather than 500", async () => {
    const token = await loginToken(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .post("/students/bulk-provision")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from('a,b\nunclosed,"quote'), "students.csv");

    expect(res.status).toBe(400);
  });

  // Sheets already prepared by the faculty office must keep working.
  it("still accepts the legacy studentId header", async () => {
    const csv = [
      "email,fullName,studentId,registrationNumber,batch,department",
      `${PREFIX}legacy@psems.dev,Legacy Header,W2J900,,22ENG,Computer Engineering`,
    ].join("\n");

    const token = await loginToken(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .post("/students/bulk-provision")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(csv), "students.csv");

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(await prisma.student.findUnique({ where: { studentId: "W2J900" } })).not.toBeNull();
  });

  it("rejects non-admin (403) and unauthenticated (401) upload attempts", async () => {
    const studentToken = await loginToken(NON_ADMIN_EMAIL, NON_ADMIN_PASSWORD);
    const csv = "email,fullName,studentIndex,department\n";

    const forbidden = await request(app)
      .post("/students/bulk-provision")
      .set("Authorization", `Bearer ${studentToken}`)
      .attach("file", Buffer.from(csv), "students.csv");
    expect(forbidden.status).toBe(403);

    const unauthenticated = await request(app)
      .post("/students/bulk-provision")
      .attach("file", Buffer.from(csv), "students.csv");
    expect(unauthenticated.status).toBe(401);
  });
});
