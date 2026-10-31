import { searchPeopleViaApollo, type ApolloPerson } from "./apollo.js";
import { addContact, type ContactRecord } from "../db/repositories/contacts.js";
import { pool } from "../db/client.js";
import { UserFacingError } from "../errors.js";

export interface DiscoveredContact {
  name: string;
  role: string;
  tier: "founder" | "recruiter" | "engineer_referral";
  profile_url: string;
  email?: string;
  email_confidence?: string;
}

/**
 * Discovers contacts exclusively through Apollo.io:
 * 1. Company size <= 50: Target Founders, Co-Founders, CTO
 * 2. Company size > 50: Target Technical Recruiters, Talent Acquisition, Engineering Hiring Managers
 * 3. Fallback: Target Lead / Senior Software Engineers for referrals
 *
 * All emails returned are verified/sourced directly from Apollo.io.
 */

export async function discoverAndSaveContacts(
  companyId: number
): Promise<{ tier: string; source: "apollo"; contacts: ContactRecord[] }> {
  const { rows } = await pool.query(
    "SELECT id, name, domain, team_size FROM companies WHERE id = $1",
    [companyId]
  );

  if (rows.length === 0) {
    throw new UserFacingError(`Company ID ${companyId} not found in database.`);
  }

  const company = rows[0];
  const domainOrName = company.domain || company.name;

  if (!domainOrName) {
    throw new UserFacingError(
      `Company ID ${companyId} has no name or domain. Please update the company record.`
    );
  }

  let teamSize = company.team_size ?? 0;
  const isSmallStartup = teamSize <= 50;

  let activeTier: "founder" | "recruiter" | "engineer_referral" = isSmallStartup
    ? "founder"
    : "recruiter";

  // Target roles
  const founderTitles = ["Founder", "Co-Founder", "Chief Technology Officer", "CTO"];
  const recruiterTitles = [
    "Technical Recruiter",
    "Talent Acquisition",
    "Engineering Manager",
    "Head of Talent",
    "Hiring Manager",
  ];
  const referralTitles = [
    "Lead Software Engineer",
    "Staff Software Engineer",
    "Senior Software Engineer",
    "Tech Lead",
    "Software Engineer",
  ];

  const primaryApolloTitles = isSmallStartup ? founderTitles : recruiterTitles;
  let apolloResults: ApolloPerson[] = await searchPeopleViaApollo(domainOrName, primaryApolloTitles, 5);

  // If company size wasn't in DB, but Apollo returned employee count, update DB!
  if (!company.team_size && apolloResults.length > 0 && apolloResults[0].organization_estimated_num_employees) {
    teamSize = apolloResults[0].organization_estimated_num_employees;
    await pool.query("UPDATE companies SET team_size = $1 WHERE id = $2", [teamSize, companyId]);
  }

  // If Tier 1 returned nothing from Apollo, try Referral Engineers on Apollo
  if (apolloResults.length === 0) {
    activeTier = "engineer_referral";
    apolloResults = await searchPeopleViaApollo(domainOrName, referralTitles, 5);
  }

  if (apolloResults.length === 0) {
    throw new UserFacingError(
      `No contacts found on Apollo.io for "${domainOrName}". To find contacts on Apollo, ensure the company has its official domain (e.g. domain.com) saved in the database.`
    );
  }

  const savedRecords: ContactRecord[] = [];
  for (const p of apolloResults) {
    const saved = await addContact({
      company_id: companyId,
      name: p.name,
      role: p.title,
      contact_tier: activeTier,
      profile_url: p.linkedin_url || "",
      email: p.email || undefined,
      email_confidence: p.email_status || (p.email ? "verified" : undefined),
      source: "apollo",
    });
    savedRecords.push(saved);
  }

  return {
    tier: activeTier,
    source: "apollo",
    contacts: savedRecords,
  };
}
