import { z } from "zod";
import { STATUSES } from "./services/statusMachine.js";

export const ContactInputSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  contact_tier: z.enum(["founder", "recruiter", "engineer_referral", "other"]).optional(),
  email: z.string().email().optional(),
  email_confidence: z.string().optional(),
  profile_url: z.string().url().optional(),
  source: z.string().optional(),
});

export const IngestCompanySchema = z.object({
  name: z.string().trim().min(1),
  team_size: z.number().int().positive().optional(),
  website: z.string().optional(),
  domain: z.string().optional(),
  emails: z.array(z.string().email()).optional(),
  contacts: z.array(ContactInputSchema).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  remote_friendly: z.boolean().optional(),
  funding_round: z.string().optional(),
  funding_amount: z.string().optional(),
  funding_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_url: z.string().optional(),
  score: z.number().int().optional(),
});

export const UpdateProfileSchema = z.object({
  company_id: z.number().int().positive(),
  website: z.string().optional(),
  domain: z.string().optional(),
  team_size: z.number().int().positive().optional(),
});

export const CompanyIdSchema = z.object({ company_id: z.number().int().positive() });
export const DraftEmailSchema = CompanyIdSchema.extend({
  contact_id: z.number().int().positive().optional(),
  focus: z.string().min(5).max(120).optional(),
  observation: z.string().min(5).max(200).optional(),
});
export const UpdateStatusSchema = CompanyIdSchema.extend({
  status: z.enum(STATUSES),
});
export const ScrapeSchema = z.object({ url: z.string().url() });
export const ChecklistFilterSchema = z.enum(["all", "new", "drafted", "sent", "followup_due"]);
export const BulkDiscoverySchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});
