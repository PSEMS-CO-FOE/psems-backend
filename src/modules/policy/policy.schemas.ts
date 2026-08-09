import { AvailabilityRequirement, SelectionConfirmer } from "@prisma/client";
import { z } from "zod";

// Every field optional: the coordinator patches individual settings rather than
// resubmitting the whole policy, so two people editing different areas cannot
// overwrite each other.
export const updatePolicySchema = z
  .object({
    allowStudentIdeas: z.boolean(),
    studentIdeasLeaderOnly: z.boolean(),
    allowSupervisorIdeas: z.boolean(),
    allowCoordinatorIdeas: z.boolean(),
    allowLecturerIdeas: z.boolean(),
    requireStudentIdeaApproval: z.boolean(),
    maxIdeasPerGroup: z.number().int().min(1).nullable(),
    allowCoSupervisorOnIdea: z.boolean(),

    interestEnabled: z.boolean(),
    maxInterestsPerGroup: z.number().int().min(1).nullable(),
    allowInterestWithdrawal: z.boolean(),
    allowLecturerInterestInGroupIdeas: z.boolean(),
    allowCoSupervisionInterest: z.boolean(),
    studentsSeeOtherGroupIdeas: z.boolean(),
    allowSupervisorSelfRequest: z.boolean(),
    selectionConfirmedBy: z.nativeEnum(SelectionConfirmer),

    allowIndividualParticipation: z.boolean(),
    autoCreateSoloGroup: z.boolean(),

    headJudgeEnabled: z.boolean(),
    requireOverallComment: z.boolean(),
    availabilityRequiredFrom: z.nativeEnum(AvailabilityRequirement),

    gradingEnabled: z.boolean(),
    caContributionPercent: z.number().min(0).max(100).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one setting to change" });

export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
