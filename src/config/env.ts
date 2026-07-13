import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be a long random string"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be a long random string"),
  ML_SERVICE_URL: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // SMTP is optional: absent in dev/test → jsonTransport fallback (emails are
  // logged, not sent). Set all four for the pilot's real university SMTP.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default("PSEMS <no-reply@psems.dev>"),
  // When set (e.g. "eng.university.lk"), lecturer self-registration only
  // accepts emails on this domain (spec 2.1: "using university email").
  UNIVERSITY_EMAIL_DOMAIN: z.string().optional(),
  // File storage: "local" (dev/test, writes to STORAGE_DIR) or "supabase"
  // (pilot). Supabase needs URL + service key + bucket.
  STORAGE_BACKEND: z.enum(["local", "supabase"]).default("local"),
  STORAGE_DIR: z.string().default("uploads"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().default("submissions"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
