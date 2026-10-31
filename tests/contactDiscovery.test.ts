import { describe, it, expect } from "vitest";

describe("contact discovery rule logic", () => {
  function getTierForCompanySize(teamSize: number): "founder" | "recruiter" {
    return teamSize <= 50 ? "founder" : "recruiter";
  }

  function predictEmail(fullName: string, domain?: string) {
    if (!domain) return null;
    const clean = fullName.toLowerCase().replace(/[^a-z\s]/g, "").trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    return last ? `${first}.${last}@${domain}` : `${first}@${domain}`;
  }

  it("assigns founder tier for companies <= 50 employees", () => {
    expect(getTierForCompanySize(10)).toBe("founder");
    expect(getTierForCompanySize(50)).toBe("founder");
  });

  it("assigns recruiter tier for companies > 50 employees", () => {
    expect(getTierForCompanySize(51)).toBe("recruiter");
    expect(getTierForCompanySize(200)).toBe("recruiter");
  });

  it("predicts correct email formats", () => {
    expect(predictEmail("Satya Nadella", "microsoft.com")).toBe("satya.nadella@microsoft.com");
    expect(predictEmail("Cher", "example.com")).toBe("cher@example.com");
    expect(predictEmail("John Doe", undefined)).toBeNull();
  });
});

