import { ResearchOutputKind } from "@prisma/client";
import { z } from "zod";

export const updateProfileSchema = z
  .object({
    headline: z.string().trim().max(200).nullable(),
    about: z.string().trim().max(5000).nullable(),
    department: z.string().trim().max(200).nullable(),
    designation: z.string().trim().max(200).nullable(),
    contactEmail: z.string().trim().email().nullable(),
    links: z.record(z.string().url()).nullable(),
    // Both child lists are replace-all — a person edits them as a whole.
    interests: z.array(z.string().trim().min(1).max(120)).max(50),
    outputs: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(500),
          venue: z.string().trim().max(300).optional(),
          year: z.number().int().min(1900).max(2100).optional(),
          url: z.string().trim().url().optional(),
          kind: z.nativeEnum(ResearchOutputKind).default(ResearchOutputKind.PUBLICATION),
        }),
      )
      .max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const searchProfilesSchema = z.object({
  area: z.string().trim().max(120).optional(),
  department: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
