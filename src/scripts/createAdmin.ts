import { Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { prisma } from "../config/database";
import { passwordPolicySchema } from "../modules/auth/auth.schemas";

// Bootstraps a System Admin directly against the database. Every other account
// route requires an existing admin — lecturers need approval, students are
// provisioned by CSV, coordinators are promoted — so a fresh deployment has no
// way in without this. Also the recovery path when every admin is locked out.
const BCRYPT_WORK_FACTOR = 12;

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error("Usage: npm run admin:create -- <email> <password>");
    process.exit(1);
  }

  const parsedPassword = passwordPolicySchema.safeParse(password);
  if (!parsedPassword.success) {
    console.error(parsedPassword.error.issues.map((issue) => issue.message).join("\n"));
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_WORK_FACTOR);

  // An existing account has its password reset rather than being left stranded,
  // which is what makes this usable for recovery and not only for bootstrap.
  const admin = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: Role.SYSTEM_ADMIN, forcePasswordChange: false },
    create: { email, passwordHash, role: Role.SYSTEM_ADMIN, forcePasswordChange: false },
  });

  console.log(`System Admin ready: ${admin.email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
