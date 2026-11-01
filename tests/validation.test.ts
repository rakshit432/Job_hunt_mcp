import { describe, expect, it } from "vitest";
import { IngestCompanySchema, UpdateStatusSchema, DraftEmailSchema } from "../src/validation.js";

describe("shared request validation", () => {
  it("accepts company ingestion with structured contacts and email lists", () => {
    const result = IngestCompanySchema.safeParse({
      name: " Acme AI ",
      emails: ["hello@acme.ai"],
      contacts: [{ name: "Taylor Example", role: "Founder", email: "taylor@acme.ai", contact_tier: "founder" }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Acme AI");
  });

  it("rejects malformed emails, invalid contact tiers, and invalid status values", () => {
    expect(IngestCompanySchema.safeParse({ name: "Acme", contacts: [{ email: "bad", contact_tier: "intern" }] }).success).toBe(false);
    expect(UpdateStatusSchema.safeParse({ company_id: 1, status: "unknown" }).success).toBe(false);
  });

  it("enforces draft personalization limits", () => {
    expect(DraftEmailSchema.safeParse({ company_id: 1, focus: "AI" }).success).toBe(false);
    expect(DraftEmailSchema.safeParse({ company_id: 1, focus: "AI scheduling" }).success).toBe(true);
  });
});
