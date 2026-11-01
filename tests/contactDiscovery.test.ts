import { describe, expect, it, vi } from "vitest";
import { runApolloWaterfall } from "../src/services/apolloWaterfall.js";
import type { ApolloPerson } from "../src/services/apollo.js";

const person = (email: string | null, email_status: string | null = "verified"): ApolloPerson => ({
  name: "Taylor Example",
  first_name: "Taylor",
  last_name: "Example",
  title: "Founder",
  email,
  email_status,
  linkedin_url: null,
});

describe("Apollo contact discovery waterfall", () => {
  it("returns verified founder contact and skips referral search", async () => {
    const search = vi.fn(async () => [person("taylor@example.com")]);
    const result = await runApolloWaterfall("example.com", 10, search);

    expect(result.tier).toBe("founder");
    expect(result.people.map((p) => p.email)).toEqual(["taylor@example.com"]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][1]).toContain("Founder");
  });

  it("falls back to engineer referrals when primary results have no verified email", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([person("guess@example.com", "unverified")])
      .mockResolvedValueOnce([person("engineer@example.com")]);
    const result = await runApolloWaterfall("example.com", 100, search);

    expect(result.tier).toBe("engineer_referral");
    expect(result.people.map((p) => p.email)).toEqual(["engineer@example.com"]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0][1]).toContain("Technical Recruiter");
    expect(search.mock.calls[1][1]).toContain("Senior Software Engineer");
  });

  it("continues with no contacts after both provider searches fail", async () => {
    const search = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const result = await runApolloWaterfall("example.com", 12, search);

    expect(result.tier).toBe("engineer_referral");
    expect(result.people).toEqual([]);
    expect(result.diagnostics.apollo).toContain("provider unavailable");
    expect(result.diagnostics.apollo_referral).toContain("provider unavailable");
  });
});
