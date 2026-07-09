import { z } from "zod";
import { passwordPolicySchema } from "../auth/auth.schemas";

// Lecturers choose their own password at registration (spec 2.1: standard
// login after approval, no forced change) — so it must meet the full policy
// up front, unlike students' system-generated temp passwords.
export const registerLecturerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1),
  password: passwordPolicySchema,
});

export type RegisterLecturerInput = z.infer<typeof registerLecturerSchema>;
