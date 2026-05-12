import { z } from "zod";

const currentYear = new Date().getFullYear();

export const researchMapRequestSchema = z
  .object({
    topic: z.string().trim().min(2, "Enter a research topic."),
    field: z.string().trim().optional().default("mechanical engineering"),
    experienceLevel: z.enum(["beginner", "intermediate", "technical"]),
    goal: z.enum(["read", "publish", "build-project", "find-researchers"]),
    fromYear: z.number().int().min(1900).max(currentYear),
    toYear: z.number().int().min(1900).max(currentYear)
  })
  .refine((value) => value.fromYear <= value.toYear, {
    message: "From year must be earlier than or equal to to year.",
    path: ["fromYear"]
  });
