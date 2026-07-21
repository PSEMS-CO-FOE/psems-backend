import bcrypt from "bcrypt";
import { parse } from "csv-parse/sync";
import crypto from "crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/database";
import { emailQueue } from "../../jobs/emailQueue";
import { assertRole } from "../shared/authorization";
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
  // Service-layer RBAC re-check (spec 9.2 defense-in-depth).
  await assertRole(actorUserId, Role.SYSTEM_ADMIN);

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

  // Pre-check duplicates so re-running an overlapping CSV provisions the missing
  // students instead of failing the batch.
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

  // Hash in parallel (bcrypt runs on the libuv threadpool) rather than serially.
  const prepared = await Promise.all(
    toCreate.map(async ({ data }) => {
      const tempPassword = generateTempPassword();
      return { data, tempPassword, passwordHash: await bcrypt.hash(tempPassword, BCRYPT_WORK_FACTOR) };
    }),
  );

  // All account creates in one transaction — the whole valid cohort lands or none does.
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

  // Enqueue only after commit — enqueue-first could email credentials for a
  // rolled-back account. Worst case here (commit ok, enqueue fails) leaves the
  // log QUEUED for the admin to retrigger.
  await Promise.all(
    createdUsers.map((user, i) =>
      emailQueue.add("credential-email", {
        kind: "credential",
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
