import { z } from "zod";

// Expected CSV header: email,fullName,studentId,department,year
export const csvStudentRowSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1, "fullName is required"),
  studentId: z.string().trim().min(1, "studentId is required"),
  department: z.string().trim().min(1, "department is required"),
  year: z.coerce.number().int().min(1).max(6),
});

export type CsvStudentRow = z.infer<typeof csvStudentRowSchema>;
