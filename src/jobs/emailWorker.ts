import { Job, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { CredentialEmailJob, EMAIL_QUEUE_NAME, queueConnection } from "./emailQueue";

// Real SMTP when configured; otherwise jsonTransport (logged, not sent) so the
// pipeline runs in dev without a mail server. Pilot switch-over is env vars only.
function buildTransport() {
  if (env.SMTP_HOST && env.SMTP_PORT) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return nodemailer.createTransport({ jsonTransport: true });
}

const transport = buildTransport();

async function processCredentialEmail(job: Job<CredentialEmailJob>) {
  const { to, fullName, tempPassword, provisioningLogId } = job.data;

  const info = await transport.sendMail({
    from: env.EMAIL_FROM,
    to,
    subject: "Your PSEMS account credentials",
    text: [
      `Hello ${fullName || to},`,
      "",
      "An account has been created for you on PSEMS (Project Scoring, Evaluation & Management System).",
      "",
      `Login email: ${to}`,
      `Temporary password: ${tempPassword}`,
      "",
      "You will be required to change this password the first time you log in.",
      "If you did not expect this email, contact your department coordinator.",
    ].join("\n"),
  });

  if (!env.SMTP_HOST) {
    // jsonTransport puts the serialized mail on .message (not in the base type).
    const devPreview = (info as { message?: string }).message;
    console.log(`[email:dev] credential mail for ${to}:`, devPreview ?? info.messageId);
  }

  await prisma.studentProvisioningLog.update({
    where: { id: provisioningLogId },
    data: { deliveryStatus: "SENT", dispatchedAt: new Date() },
  });
}

export function startEmailWorker(): Worker<CredentialEmailJob> {
  const worker = new Worker<CredentialEmailJob>(EMAIL_QUEUE_NAME, processCredentialEmail, {
    connection: queueConnection,
  });

  // Flag delivery as failed only after all retry attempts are exhausted.
  worker.on("failed", async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    console.error(`[email] delivery permanently failed for job ${job.id}:`, err.message);
    await prisma.studentProvisioningLog
      .update({
        where: { id: job.data.provisioningLogId },
        data: { deliveryStatus: "FAILED", failureReason: err.message },
      })
      .catch((updateErr) => console.error("[email] failed to record delivery failure", updateErr));
  });

  return worker;
}
