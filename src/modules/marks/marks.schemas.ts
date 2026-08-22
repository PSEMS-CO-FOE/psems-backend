import { z } from "zod";

// stageId null publishes the whole course; a stage id sets that stage only.
// Three separate switches: feedback can go out before the numbers, and the grade
// later still, since releasing a grade is a decision taken once everything is in.
export const publicationSchema = z.object({
  stageId: z.string().uuid().nullable().default(null),
  publishMarks: z.boolean(),
  publishComments: z.boolean(),
  publishGrades: z.boolean().default(false),
});

export const gradeBandsSchema = z.object({
  bands: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(10),
        minPercent: z.number().min(0).max(100),
      }),
    )
    .max(20),
});

export type PublicationBody = z.infer<typeof publicationSchema>;
export type GradeBandsBody = z.infer<typeof gradeBandsSchema>;
