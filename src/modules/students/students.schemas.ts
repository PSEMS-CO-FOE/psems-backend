import { z } from "zod";

// Expected CSV header: email,fullName,studentId,registrationNumber,department,year
//
// registrationNumber is optional so older files still load. Mark sheets carry it
// as a second column next to the index number, and it stays blank without it.
export const csvStudentRowSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1, "fullName is required"),
  studentId: z.string().trim().min(1, "studentId is required"),
  registrationNumber: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  department: z.string().trim().min(1, "department is required"),
  year: z.coerce.number().int().min(1).max(6),
});

export type CsvStudentRow = z.infer<typeof csvStudentRowSchema>;
