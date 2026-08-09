import { Job, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { prisma } from "../config/database";
import { env } from "../config/env";
import { EmailJob, EMAIL_QUEUE_NAME, queueConnection } from "./emailQueue";

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

async function send(to: string, subject: string, text: string) {
  const info = await transport.sendMail({ from: env.EMAIL_FROM, to, subject, text });
  if (!env.SMTP_HOST) {
    // jsonTransport puts the serialized mail on .message (not in the base type).
    const devPreview = (info as { message?: string }).message;
    console.log(`[email:dev] "${subject}" -> ${to}:`, devPreview ?? info.messageId);
  }
}

async function processEmail(job: Job<EmailJob>) {
  if (job.data.kind === "credential") {
    const { to, fullName, tempPassword, provisioningLogId } = job.data;
    await send(
      to,
      "Your PSEMS account credentials",
      [
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
    );
    await prisma.provisioningLog.update({
      where: { id: provisioningLogId },
      data: { deliveryStatus: "SENT", dispatchedAt: new Date() },
    });
    return;
  }

  await send(job.data.to, job.data.subject, job.data.text);
}

export function startEmailWorker(): Worker<EmailJob> {
  const worker = new Worker<EmailJob>(EMAIL_QUEUE_NAME, processEmail, { connection: queueConnection });

  // Flag credential delivery as failed only after all retries are exhausted.
  worker.on("failed", async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    console.error(`[email] delivery permanently failed for job ${job.id}:`, err.message);
    if (job.data.kind === "credential") {
      await prisma.provisioningLog
        .update({ where: { id: job.data.provisioningLogId }, data: { deliveryStatus: "FAILED", failureReason: err.message } })
        .catch((updateErr) => console.error("[email] failed to record delivery failure", updateErr));
    }
  });

  return worker;
}
