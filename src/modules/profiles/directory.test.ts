import bcrypt from "bcrypt";
import request from "supertest";
import { Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

// The directory and the top search bar share this endpoint, and it had broken
// twice unnoticed because nothing covered it.
const PREFIX = "directory.";
const LECT_EMAIL = `${PREFIX}lecturer@psems.dev`;
const LECT_PASSWORD = "Lecturer#Pass1";

async function seed(email: string, role: Role, fullName: string, password = "Seed#TestPass1") {
  return prisma.user.create({
    data: { email, fullName, passwordHash: await bcrypt.hash(password, 12), role },
  });
}

async function search(token: string, q?: string) {
  const res = await request(app)
    .get("/profiles/search")
    .query(q ? { q } : {})
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as { user: { email: string; role: string } }[];
}

describe("The people directory", () => {
  let token: string;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    await seed(LECT_EMAIL, Role.LECTURER, "Dulina Hansa Nimsara", LECT_PASSWORD);
    await seed(`${PREFIX}student@psems.dev`, Role.STUDENT, "Student Person");
    await seed(`${PREFIX}admin@psems.dev`, Role.SYSTEM_ADMIN, "Admin Person");
    await seed(`${PREFIX}super@psems.dev`, Role.SUPER_ADMIN, "Super Person");
    const suspended = await seed(`${PREFIX}suspended@psems.dev`, Role.LECTURER, "Suspended Person");
    await prisma.user.update({ where: { id: suspended.id }, data: { suspendedAt: new Date() } });

    const login = await request(app).post("/auth/login").send({ email: LECT_EMAIL, password: LECT_PASSWORD });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
    await emailQueue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  // Querying `userProfile` meant anyone who had never opened Edit my profile
  // did not exist here — which, on a new deployment, is everyone.
  it("finds someone who has never filled in a profile", async () => {
    const hits = await search(token, "Dulina");
    expect(hits.map((h) => h.user.email)).toContain(LECT_EMAIL);
  });

  it("matches on an email as well as a name", async () => {
    const hits = await search(token, `${PREFIX}student`);
    expect(hits.map((h) => h.user.email)).toContain(`${PREFIX}student@psems.dev`);
  });

  it("leaves administrators out, since neither supervises or joins a group", async () => {
    const roles = (await search(token)).map((h) => h.user.role);
    expect(roles).not.toContain("SYSTEM_ADMIN");
    expect(roles).not.toContain("SUPER_ADMIN");
  });

  it("leaves out someone suspended", async () => {
    const emails = (await search(token)).map((h) => h.user.email);
    expect(emails).not.toContain(`${PREFIX}suspended@psems.dev`);
  });

  it("still lists lecturers and students", async () => {
    const emails = (await search(token)).map((h) => h.user.email);
    expect(emails).toEqual(expect.arrayContaining([LECT_EMAIL, `${PREFIX}student@psems.dev`]));
  });
});
