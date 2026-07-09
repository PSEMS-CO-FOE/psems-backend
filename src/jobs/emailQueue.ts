import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

// BullMQ requires its own connection: workers use blocking Redis commands,
// which the shared request-path client's default retry policy would break.
export const queueConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const EMAIL_QUEUE_NAME = "email";

export interface CredentialEmailJob {
  to: string;
  fullName: string;
  tempPassword: string;
  provisioningLogId: string;
}

export const emailQueue = new Queue<CredentialEmailJob>(EMAIL_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 }, // keep last 1000 for inspection, don't grow Redis forever
    removeOnFail: false, // failed jobs stay visible until manually cleared
  },
});
