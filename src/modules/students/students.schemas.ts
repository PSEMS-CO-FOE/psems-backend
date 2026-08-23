import { z } from "zod";

// Expected CSV header: email,fullName,studentIndex,registrationNumber,batch,department
//
// studentIndex is the index number (22ENG082); registrationNumber is the
// registration number (EN108960). Both older headers for the index still work.
const indexAliases = ["studentIndex", "indexNumber", "studentId"] as const;

export const csvStudentRowSchema = z
  .preprocess((raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const row = { ...(raw as Record<string, unknown>) };
    const alias = indexAliases.find((key) => typeof row[key] === "string" && (row[key] as string).trim());
    if (alias) row.studentIndex = row[alias];
    return row;
  }, z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1, "fullName is required"),
  studentIndex: z.string().trim().min(1, "studentIndex is required"),
  registrationNumber: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  // The intake, e.g. 22ENG. Required: it is what decides which courses this
  // student can see, and a missing one would leave them seeing nothing.
  batch: z.string().trim().min(1, "batch is required"),
  department: z.string().trim().min(1, "department is required"),
}));

export type CsvStudentRow = z.infer<typeof csvStudentRowSchema>;
