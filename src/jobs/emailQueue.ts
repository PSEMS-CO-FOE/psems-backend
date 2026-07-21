import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

// BullMQ requires its own connection: workers use blocking Redis commands,
// which the shared request-path client's default retry policy would break.
export const queueConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const EMAIL_QUEUE_NAME = "email";

// Discriminated union so one queue/worker handles both provisioning credentials
// and generic notification emails.
export type EmailJob =
  | { kind: "credential"; to: string; fullName: string; tempPassword: string; provisioningLogId: string }
  | { kind: "notification"; to: string; subject: string; text: string };

export const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  },
});

export function enqueueNotificationEmail(to: string, subject: string, text: string) {
  return emailQueue.add("notification-email", { kind: "notification", to, subject, text });
}
