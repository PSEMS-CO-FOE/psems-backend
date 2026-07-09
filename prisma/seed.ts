import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const BCRYPT_WORK_FACTOR = 12;

async function main() {
  const adminPasswordHash = await bcrypt.hash("Admin#Pilot2026", BCRYPT_WORK_FACTOR);
  const studentTempPasswordHash = await bcrypt.hash("Temp#Passw0rd1", BCRYPT_WORK_FACTOR);

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

  console.log("Seeded users:");
  console.log(`  Admin:   ${admin.email} / Admin#Pilot2026`);
  console.log(`  Student: ${studentUser.email} / Temp#Passw0rd1 (force_password_change = true)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
