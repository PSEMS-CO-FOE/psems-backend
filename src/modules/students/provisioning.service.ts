import bcrypt from "bcrypt";
import { parse } from "csv-parse/sync";
import crypto from "crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/database";
import { emailQueue } from "../../jobs/emailQueue";
import { AuthError } from "../auth/auth.service";
import { csvStudentRowSchema, CsvStudentRow } from "./students.schemas";
import { generateTempPassword } from "./tempPassword";

const BCRYPT_WORK_FACTOR = 12;

export interface BulkProvisionResult {
  batchId: string;
  created: number;
  skipped: { row: number; email: string; reason: string }[];
  invalid: { row: number; issues: string[] }[];
}

export async function bulkProvisionStudents(
  actorUserId: string,
  csvBuffer: Buffer,
): Promise<BulkProvisionResult> {
  // Service-layer RBAC re-check (spec 9.2 defense in depth): even if route
  // middleware were bypassed or misconfigured, this write refuses non-admins.
  const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!actor || actor.role !== Role.SYSTEM_ADMIN) {
    throw new AuthError(403, "Only a System Admin can provision students");
  }

  const rawRows: Record<string, string>[] = parse(csvBuffer, {
    columns: true, // first line is the header row
    skip_empty_lines: true,
    trim: true,
  });

  // Validate every row up front; report failures by row number (header = row 1).
  const valid: { row: number; data: CsvStudentRow }[] = [];
  const invalid: BulkProvisionResult["invalid"] = [];
  rawRows.forEach((raw, i) => {
    const parsed = csvStudentRowSchema.safeParse(raw);
    if (parsed.success) {
      valid.push({ row: i + 2, data: parsed.data });
    } else {
      invalid.push({ row: i + 2, issues: parsed.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`) });
    }
  });

  // Pre-check duplicates (existing accounts and repeats within the file) so a
  // re-run of an overlapping CSV provisions the missing students instead of failing.
  const emails = valid.map((v) => v.data.email);
  const studentIds = valid.map((v) => v.data.studentId);
  const [existingUsers, existingStudents] = await Promise.all([
    prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } }),
    prisma.student.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true } }),
  ]);
  const existingEmailSet = new Set(existingUsers.map((u) => u.email));
  const existingStudentIdSet = new Set(existingStudents.map((s) => s.studentId));

  const skipped: BulkProvisionResult["skipped"] = [];
  const seenInFile = new Set<string>();
  const toCreate: { row: number; data: CsvStudentRow }[] = [];
  for (const entry of valid) {
    const { email, studentId } = entry.data;
    if (existingEmailSet.has(email)) {
      skipped.push({ row: entry.row, email, reason: "email already has an account" });
    } else if (existingStudentIdSet.has(studentId)) {
      skipped.push({ row: entry.row, email, reason: `studentId ${studentId} already exists` });
    } else if (seenInFile.has(email) || seenInFile.has(studentId)) {
      skipped.push({ row: entry.row, email, reason: "duplicate row within this file" });
    } else {
      seenInFile.add(email);
      seenInFile.add(studentId);
      toCreate.push(entry);
    }
  }

  const batchId = crypto.randomUUID();

  // bcrypt at work factor 12 costs ~250ms CPU per hash; hashing in parallel
  // uses the libuv threadpool (4 threads by default) instead of serializing.
  const prepared = await Promise.all(
    toCreate.map(async ({ data }) => {
      const tempPassword = generateTempPassword();
      return { data, tempPassword, passwordHash: await bcrypt.hash(tempPassword, BCRYPT_WORK_FACTOR) };
    }),
  );

  // One transaction for all account creates: either the whole cohort's valid
  // rows land, or none do. Nested create writes User + Student + provisioning
  // log atomically per student.
  const createOps = prepared.map(({ data, passwordHash }) =>
    prisma.user.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        passwordHash,
        role: Role.STUDENT,
        forcePasswordChange: true, // Week 1's gate takes over from here
        student: {
          create: {
            studentId: data.studentId,
            department: data.department,
            year: data.year,
          },
        },
        provisioningLogs: {
          create: { batchId, email: data.email },
        },
      },
      include: { provisioningLogs: { where: { batchId } } },
    }),
  );
  const createdUsers = await prisma.$transaction(createOps, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });

  // Enqueue ONLY after the transaction commits: enqueue-first could email
  // credentials for accounts whose creation then rolled back. This ordering's
  // worst case (commit ok, enqueue fails) just leaves logs in QUEUED, which
  // the admin can see and retrigger.
  await Promise.all(
    createdUsers.map((user, i) =>
      emailQueue.add("credential-email", {
        to: user.email,
        fullName: user.fullName,
        tempPassword: prepared[i].tempPassword,
        provisioningLogId: user.provisioningLogs[0].id,
      }),
    ),
  );

  return { batchId, created: createdUsers.length, skipped, invalid };
}

export async function getBatchStatus(batchId: string) {
  const logs = await prisma.studentProvisioningLog.findMany({
    where: { batchId },
    select: { email: true, deliveryStatus: true, failureReason: true, dispatchedAt: true },
    orderBy: { email: "asc" },
  });
  return {
    batchId,
    total: logs.length,
    sent: logs.filter((l) => l.deliveryStatus === "SENT").length,
    failed: logs.filter((l) => l.deliveryStatus === "FAILED").length,
    queued: logs.filter((l) => l.deliveryStatus === "QUEUED").length,
    students: logs,
  };
}
