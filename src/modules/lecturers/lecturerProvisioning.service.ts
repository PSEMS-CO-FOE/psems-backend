import bcrypt from "bcrypt";
import { parse } from "csv-parse/sync";
import crypto from "crypto";
import { LecturerApprovalStatus, Prisma, ProvisioningSubject, Role } from "@prisma/client";
import { prisma } from "../../config/database";
import { emailQueue } from "../../jobs/emailQueue";
import { assertRole } from "../shared/authorization";
import { generateTempPassword } from "../students/tempPassword";
import { BulkProvisionResult } from "../students/provisioning.service";
import { csvLecturerRowSchema, CsvLecturerRow } from "./lecturers.schemas";

const BCRYPT_WORK_FACTOR = 12;

// Bulk-provision lecturers from a CSV, mirroring the student pipeline: validate
// every row, skip anyone who already has an account, create in one transaction,
// then enqueue credential emails only after commit.
//
// Two deliberate differences from self-registration: these accounts are
// AUTO-APPROVED (an admin uploaded them, so the approval queue adds nothing),
// and they carry forcePasswordChange, which is the piece lecturers previously
// had no route to at all.
export async function bulkProvisionLecturers(
  actorUserId: string,
  csvBuffer: Buffer,
): Promise<BulkProvisionResult> {
  await assertRole(actorUserId, Role.SYSTEM_ADMIN);

  const rawRows: Record<string, string>[] = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const valid: { row: number; data: CsvLecturerRow }[] = [];
  const invalid: BulkProvisionResult["invalid"] = [];
  rawRows.forEach((raw, i) => {
    const parsed = csvLecturerRowSchema.safeParse(raw);
    if (parsed.success) {
      valid.push({ row: i + 2, data: parsed.data });
    } else {
      invalid.push({ row: i + 2, issues: parsed.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`) });
    }
  });

  const emails = valid.map((v) => v.data.email);
  const existingUsers = await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } });
  const existingEmailSet = new Set(existingUsers.map((u) => u.email));

  const skipped: BulkProvisionResult["skipped"] = [];
  const seenInFile = new Set<string>();
  const toCreate: { row: number; data: CsvLecturerRow }[] = [];
  for (const entry of valid) {
    const { email } = entry.data;
    if (existingEmailSet.has(email)) {
      skipped.push({ row: entry.row, email, reason: "email already has an account" });
    } else if (seenInFile.has(email)) {
      skipped.push({ row: entry.row, email, reason: "duplicate row within this file" });
    } else {
      seenInFile.add(email);
      toCreate.push(entry);
    }
  }

  const batchId = crypto.randomUUID();

  const prepared = await Promise.all(
    toCreate.map(async ({ data }) => {
      const tempPassword = generateTempPassword();
      return { data, tempPassword, passwordHash: await bcrypt.hash(tempPassword, BCRYPT_WORK_FACTOR) };
    }),
  );

  const createOps = prepared.map(({ data, passwordHash }) =>
    prisma.user.create({
      data: {
        email: data.email,
        fullName: data.fullName,
        passwordHash,
        role: Role.LECTURER,
        forcePasswordChange: true,
        lecturer: {
          create: { selfRegistered: false, approvalStatus: LecturerApprovalStatus.APPROVED },
        },
        // A profile is seeded from the CSV so the directory is populated from
        // day one rather than waiting for each lecturer to fill it in.
        profile: {
          create: { department: data.department, designation: data.designation ?? null },
        },
        provisioningLogs: {
          create: { batchId, email: data.email, subjectType: ProvisioningSubject.LECTURER },
        },
      },
      include: { provisioningLogs: { where: { batchId } } },
    }),
  );
  const createdUsers = await prisma.$transaction(createOps, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });

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
