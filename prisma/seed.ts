import { LecturerApprovalStatus, PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const BCRYPT_WORK_FACTOR = 12;

// These passwords are committed to a public repo, so this must never touch a
// real database. A deployment gets its first account from `npm run admin:create`.
function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed: these accounts have published passwords.");
    console.error("Create the first real account with: npm run admin:create -- <email> <password>");
    process.exit(1);
  }
}

async function main() {
  assertNotProduction();

  const adminPasswordHash = await bcrypt.hash("Admin#Pilot2026", BCRYPT_WORK_FACTOR);
  const studentTempPasswordHash = await bcrypt.hash("Temp#Passw0rd1", BCRYPT_WORK_FACTOR);
  const coordinatorPasswordHash = await bcrypt.hash("Coord#Pilot2026", BCRYPT_WORK_FACTOR);
  const lecturerPasswordHash = await bcrypt.hash("Lect#Pilot2026", BCRYPT_WORK_FACTOR);

  const admin = await prisma.user.upsert({
    where: { email: "admin@psems.dev" },
    update: {},
    create: {
      email: "admin@psems.dev",
      passwordHash: adminPasswordHash,
      role: Role.SYSTEM_ADMIN,
      forcePasswordChange: false,
    },
  });

  const studentUser = await prisma.user.upsert({
    where: { email: "student1@psems.dev" },
    update: {},
    create: {
      email: "student1@psems.dev",
      passwordHash: studentTempPasswordHash,
      role: Role.STUDENT,
      forcePasswordChange: true,
      student: {
        create: {
          studentId: "STU0001",
          department: "Computer Engineering",
          year: 4,
        },
      },
    },
  });

  // A Course Coordinator: an approved lecturer already promoted to the
  // coordinator role. Keeps its lecturer profile row (approval history intact).
  const coordinator = await prisma.user.upsert({
    where: { email: "coordinator@psems.dev" },
    update: {},
    create: {
      email: "coordinator@psems.dev",
      fullName: "Prof. Coordinator",
      passwordHash: coordinatorPasswordHash,
      role: Role.COURSE_COORDINATOR,
      forcePasswordChange: false,
      lecturer: {
        create: { selfRegistered: false, approvalStatus: LecturerApprovalStatus.APPROVED },
      },
    },
  });

  // Two approved lecturers available to be invited as supervisors / assigned
  // as evaluators in a CPI.
  const lecturers = [];
  for (const [email, fullName] of [
    ["lecturer1@psems.dev", "Dr. Alpha"],
    ["lecturer2@psems.dev", "Dr. Beta"],
  ]) {
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        fullName,
        passwordHash: lecturerPasswordHash,
        role: Role.LECTURER,
        forcePasswordChange: false,
        lecturer: {
          create: { selfRegistered: true, approvalStatus: LecturerApprovalStatus.APPROVED },
        },
      },
    });
    lecturers.push(user);
  }

  console.log("Seeded users:");
  console.log(`  Admin:       ${admin.email} / Admin#Pilot2026`);
  console.log(`  Student:     ${studentUser.email} / Temp#Passw0rd1 (force_password_change = true)`);
  console.log(`  Coordinator: ${coordinator.email} / Coord#Pilot2026`);
  console.log(`  Lecturers:   ${lecturers.map((l) => l.email).join(", ")} / Lect#Pilot2026`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
