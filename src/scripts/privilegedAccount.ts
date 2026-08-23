import { Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { prisma } from "../config/database";
import { passwordPolicySchema } from "../modules/auth/auth.schemas";

const BCRYPT_WORK_FACTOR = 12;

// Both tiers are created identically and differ only in role.
export async function createPrivilegedAccount(role: Role, usage: string) {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }

  const parsedPassword = passwordPolicySchema.safeParse(password);
  if (!parsedPassword.success) {
    console.error(parsedPassword.error.issues.map((issue) => issue.message).join("\n"));
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_WORK_FACTOR);

  // Upsert, so this doubles as the recovery path for a locked-out account.
  const account = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role, forcePasswordChange: false, suspendedAt: null, suspendedReason: null },
    create: { email, passwordHash, role, forcePasswordChange: false },
  });

  console.log(`${role} ready: ${account.email}`);
}

export async function runAccountScript(role: Role, usage: string) {
  try {
    await createPrivilegedAccount(role, usage);
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
