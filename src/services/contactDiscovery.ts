import { searchPeople, type SearchResultItem } from "./firecrawl.js";
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
 * Parses person's name and role from LinkedIn search result titles.
 * Typical format: "Jane Doe - Co-Founder & CTO - Acme | LinkedIn"
 */
function parsePersonFromTitle(
  item: SearchResultItem,
  companyName: string
): { name: string; role: string } | null {
  const cleanTitle = item.title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const parts = cleanTitle.split(/\s*[-–—|]\s*/);

  if (parts.length >= 2) {
    const name = parts[0].trim();
    if (name.toLowerCase() === companyName.toLowerCase()) {
      return null;
    }
    const role = parts[1].replace(new RegExp(`\\s+(at|@)\\s+${companyName}.*`, "i"), "").trim();
    return { name, role: role || "Team Member" };
  }

  return null;
}

/**
 * Fallback corporate email prediction when Apollo has no verified address.
 */
function predictEmail(
  fullName: string,
  domain?: string | null
): { email?: string; confidence?: string } {
  if (!domain) return {};

  const cleanName = fullName.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const nameParts = cleanName.split(/\s+/).filter(Boolean);

  if (nameParts.length === 0) return {};

  const first = nameParts[0];
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

  const email = last ? `${first}.${last}@${domain}` : `${first}@${domain}`;
  return { email, confidence: "predicted" };
}

/**
 * Discovers contacts following your tiered recruitment rule using Apollo.io
 * (with Firecrawl as intelligent fallback):
 * 1. Company size <= 50: Target Founders, Co-Founders, CTO
 * 2. Company size > 50: Target Technical Recruiters, Talent Acquisition, Engineering Hiring Managers
 * 3. Fallback: Target Lead / Senior Software Engineers for referrals
 */
export async function discoverAndSaveContacts(
  companyId: number
): Promise<{ tier: string; source: "apollo" | "firecrawl"; contacts: ContactRecord[] }> {
  const { rows } = await pool.query(
    "SELECT id, name, domain, team_size FROM companies WHERE id = $1",
    [companyId]
  );

  if (rows.length === 0) {
    throw new UserFacingError(`Company ID ${companyId} not found.`);
  }

  const company = rows[0];
  const domainOrName = company.domain || company.name;
  let teamSize = company.team_size ?? 0;
  const isSmallStartup = teamSize <= 50;

  let activeTier: "founder" | "recruiter" | "engineer_referral" = isSmallStartup
    ? "founder"
    : "recruiter";

  let parsedContacts: DiscoveredContact[] = [];
  let discoverySource: "apollo" | "firecrawl" = "apollo";

  // -------------------------------------------------------------
  // ATTEMPT 1: Apollo.io Search for Verified B2B Emails & Profiles
  // -------------------------------------------------------------
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

  // If company size wasn't in DB, but Apollo returned organization size, update DB!
  if (!company.team_size && apolloResults.length > 0 && apolloResults[0].organization_estimated_num_employees) {
    teamSize = apolloResults[0].organization_estimated_num_employees;
    await pool.query("UPDATE companies SET team_size = $1 WHERE id = $2", [teamSize, companyId]);
  }

  // If Tier 1 returned nothing from Apollo, try Referral Engineers on Apollo
  if (apolloResults.length === 0) {
    activeTier = "engineer_referral";
    apolloResults = await searchPeopleViaApollo(domainOrName, referralTitles, 5);
  }

  if (apolloResults.length > 0) {
    for (const p of apolloResults) {
      parsedContacts.push({
        name: p.name,
        role: p.title,
        tier: activeTier,
        profile_url: p.linkedin_url || "",
        email: p.email || predictEmail(p.name, company.domain).email,
        email_confidence: p.email_status || (p.email ? "verified" : "predicted"),
      });
    }
  }

  // -------------------------------------------------------------
  // ATTEMPT 2: Firecrawl Web & LinkedIn Search (Fallback)
  // -------------------------------------------------------------
  if (parsedContacts.length === 0) {
    discoverySource = "firecrawl";
    activeTier = isSmallStartup ? "founder" : "recruiter";

    const primaryQuery = isSmallStartup
      ? `site:linkedin.com/in "${company.name}" ("Founder" OR "Co-Founder" OR "CTO")`
      : `site:linkedin.com/in "${company.name}" ("Technical Recruiter" OR "Talent Acquisition" OR "Engineering Manager")`;

    let firecrawlResults = await searchPeople(primaryQuery, 5);

    for (const item of firecrawlResults) {
      const parsed = parsePersonFromTitle(item, company.name);
      if (parsed) {
        const emailInfo = predictEmail(parsed.name, company.domain);
        parsedContacts.push({
          name: parsed.name,
          role: parsed.role,
          tier: activeTier,
          profile_url: item.url,
          email: emailInfo.email,
          email_confidence: emailInfo.confidence,
        });
      }
    }

    // Referral Fallback via Firecrawl
    if (parsedContacts.length === 0) {
      activeTier = "engineer_referral";
      const referralQuery = `site:linkedin.com/in "${company.name}" ("Lead Software Engineer" OR "Senior Software Engineer" OR "Tech Lead")`;
      firecrawlResults = await searchPeople(referralQuery, 5);

      for (const item of firecrawlResults) {
        const parsed = parsePersonFromTitle(item, company.name);
        if (parsed) {
          const emailInfo = predictEmail(parsed.name, company.domain);
          parsedContacts.push({
            name: parsed.name,
            role: parsed.role,
            tier: activeTier,
            profile_url: item.url,
            email: emailInfo.email,
            email_confidence: emailInfo.confidence,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------
  // Save all discovered contacts into the PostgreSQL database
  // -------------------------------------------------------------
  const savedRecords: ContactRecord[] = [];
  for (const c of parsedContacts) {
    const saved = await addContact({
      company_id: companyId,
      name: c.name,
      role: c.role,
      contact_tier: c.tier,
      profile_url: c.profile_url,
      email: c.email,
      email_confidence: c.email_confidence,
      source: discoverySource,
    });
    savedRecords.push(saved);
  }

  return {
    tier: activeTier,
    source: discoverySource,
    contacts: savedRecords,
  };
}
