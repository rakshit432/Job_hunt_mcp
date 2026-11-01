import { searchPeopleViaApollo, type ApolloPerson } from "./apollo.js";
import { findEmailViaProspeo } from "./prospeo.js";
import { findEmailViaSnov } from "./snov.js";
import { searchPeople, fetchEmailsFromDomain } from "./firecrawl.js";
import { scrapeMcaMasterData, scrapeAcceleratorPortfolios, scrapeStartupDirectories } from "./registryDiscovery.js";
import { addContact, type ContactRecord } from "../db/repositories/contacts.js";
import { pool } from "../db/client.js";

function parseLinkedInTitle(rawTitle: string): { name: string; role: string } {
  // Format: "John Doe - Founder & CEO - Acme Corp | LinkedIn"
  const cleaned = rawTitle.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const parts = cleaned.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) {
    return {
      name: parts[0].trim(),
      role: parts[1].trim(),
    };
  }
  return {
    name: cleaned || "Team Member",
    role: "Team Member",
  };
}

/**
 * Discover contacts for a company with strict zero-prediction:
 *
 * Waterfall:
 *   1️⃣ Apollo.io (if configured & working)
 *   2️⃣ Firecrawl LinkedIn Search + Prospeo / Snov.io Waterfall:
 *        - Google Dork finds official LinkedIn profile URLs for founders/recruiters
 *        - Prospeo checks LinkedIn URL -> 100% verified work email
 *        - Snov.io checks LinkedIn URL -> 100% verified work email
 *   3️⃣ Company Homepage Direct Scrape (official published contact email)
 *
 * No emails are ever predicted or guessed.
 */
export async function discoverAndSaveContacts(
  companyId: number
): Promise<{
  tier: string;
  source: string;
  contacts: ContactRecord[];
}> {
  const { rows } = await pool.query(
    "SELECT id, name, domain, team_size FROM companies WHERE id = $1",
    [companyId]
  );

  if (rows.length === 0) {
    return { tier: "", source: "", contacts: [] };
  }

  const company = rows[0];
  const domainOrName = company.domain || company.name;

  if (!domainOrName) {
    return { tier: "", source: "", contacts: [] };
  }

  const teamSize = company.team_size ?? 0;
  const isSmallStartup = teamSize <= 50;
  let activeTier: "founder" | "recruiter" | "engineer_referral" = isSmallStartup ? "founder" : "recruiter";

  // ── 1️⃣ Apollo.io Attempt ──────────────────────────────────────────────────
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
  ];

  const primaryApolloTitles = isSmallStartup ? founderTitles : recruiterTitles;
  let apolloResults: ApolloPerson[] = [];
  try {
    apolloResults = await searchPeopleViaApollo(domainOrName, primaryApolloTitles, 5);
  } catch (e) {
    console.warn("Apollo lookup failed, falling back to LinkedIn waterfall:", (e as Error).message);
  }

  if (apolloResults.length === 0) {
    activeTier = "engineer_referral";
    try {
      apolloResults = await searchPeopleViaApollo(domainOrName, referralTitles, 5);
    } catch {
      // ignore
    }
  }

  // Filter to only contacts that have verified emails from Apollo
  const verifiedApollo = apolloResults.filter((p) => p.email);
  if (verifiedApollo.length > 0) {
    const saved = await saveApolloContacts(companyId, activeTier, verifiedApollo);
    return { tier: activeTier, source: "apollo", contacts: saved };
  }

  // ── 2️⃣ Firecrawl LinkedIn Search + Prospeo / Snov Waterfall ──────────────
  try {
    const targetQuery = isSmallStartup
      ? `site:linkedin.com/in "${company.name}" (Founder OR "Co-Founder" OR CTO OR CEO)`
      : `site:linkedin.com/in "${company.name}" ("Technical Recruiter" OR "Engineering Manager" OR "Head of Talent")`;

    const searchHits = await searchPeople(targetQuery, 5);
    const validHits = searchHits.filter((h) => h.url && h.url.includes("linkedin.com/in/"));

    if (validHits.length > 0) {
      const savedContacts: ContactRecord[] = [];

      for (const hit of validHits) {
        const { name, role } = parseLinkedInTitle(hit.title);

        let email: string | undefined = undefined;
        let emailConfidence: string | undefined = undefined;
        let contactSource: string = "linkedin";

        // Step 2a: Try Prospeo (75 free/mo)
        const prospeoRes = await findEmailViaProspeo(hit.url);
        if (prospeoRes?.email && prospeoRes.email_status === "VERIFIED") {
          email = prospeoRes.email;
          emailConfidence = "verified";
          contactSource = "prospeo";
        }

        // Step 2b: Fall back to Snov.io (50 free/mo) if Prospeo didn't find an email
        if (!email) {
          const snovRes = await findEmailViaSnov(hit.url);
          if (snovRes?.email && snovRes.email_status === "verified") {
            email = snovRes.email;
            emailConfidence = "verified";
            contactSource = "snov";
          }
        }

        const saved = await addContact({
          company_id: companyId,
          name: name || "Leadership Member",
          role: role || activeTier,
          contact_tier: activeTier,
          profile_url: hit.url,
          email,
          email_confidence: emailConfidence,
          source: contactSource,
        });

        savedContacts.push(saved);
      }

      if (savedContacts.length > 0) {
        return {
          tier: activeTier,
          source: savedContacts.some((c) => c.email) ? "verified_waterfall" : "linkedin_directory",
          contacts: savedContacts,
        };
      }
    }
  } catch (err) {
    console.warn("LinkedIn search waterfall failed:", (err as Error).message);
  }

  // ── 3️⃣ Company Official Domain Scrape Fallback ───────────────────────────
  if (company.domain) {
    try {
      const scrapedEmails = await fetchEmailsFromDomain(company.domain, 3);
      if (scrapedEmails.length > 0) {
        const saved: ContactRecord[] = [];
        for (const email of scrapedEmails) {
          const rec = await addContact({
            company_id: companyId,
            name: `${company.name} Official Contact`,
            role: "Direct Inquiries",
            contact_tier: activeTier,
            profile_url: company.domain,
            email,
            email_confidence: "verified",
            source: "company_website",
          });
          saved.push(rec);
        }
        return { tier: activeTier, source: "company_website", contacts: saved };
      }
    } catch (err) {
      console.warn("Domain homepage scrape failed:", (err as Error).message);
    }
  }

  // ── 4️⃣ MCA Corporate Registry (ZaubaCorp / TheCompanyCheck) ────────────────
  try {
    const mcaContacts = await scrapeMcaMasterData(company.name);
    if (mcaContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of mcaContacts) {
        const rec = await addContact({
          company_id: companyId,
          name: c.name,
          role: c.role,
          contact_tier: "founder",
          profile_url: c.sourceUrl,
          email: c.email,
          email_confidence: c.email ? "verified" : undefined,
          source: "mca_registry",
        });
        saved.push(rec);
      }
      return { tier: "founder", source: "mca_registry", contacts: saved };
    }
  } catch (err) {
    console.warn("MCA registry lookup failed:", (err as Error).message);
  }

  // ── 5️⃣ Accelerator & VC Portfolio Pages (YC, Peak XV, Blume) ────────────
  try {
    const portContacts = await scrapeAcceleratorPortfolios(company.name);
    if (portContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of portContacts) {
        const rec = await addContact({
          company_id: companyId,
          name: c.name,
          role: c.role,
          contact_tier: "founder",
          profile_url: c.sourceUrl,
          email: c.email,
          email_confidence: c.email ? "verified" : undefined,
          source: "accelerator_portfolio",
        });
        saved.push(rec);
      }
      return { tier: "founder", source: "accelerator_portfolio", contacts: saved };
    }
  } catch (err) {
    console.warn("Accelerator portfolio lookup failed:", (err as Error).message);
  }

  // ── 6️⃣ Startup Directories (Wellfound, Inc42, Entrackr) ──────────────────
  try {
    const dirContacts = await scrapeStartupDirectories(company.name);
    if (dirContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of dirContacts) {
        const rec = await addContact({
          company_id: companyId,
          name: c.name,
          role: c.role,
          contact_tier: activeTier,
          profile_url: c.sourceUrl,
          email: c.email,
          email_confidence: c.email ? "verified" : undefined,
          source: "startup_directory",
        });
        saved.push(rec);
      }
      return { tier: activeTier, source: "startup_directory", contacts: saved };
    }
  } catch (err) {
    console.warn("Startup directory lookup failed:", (err as Error).message);
  }

  // Nothing found across all sources — return empty
  return { tier: "", source: "", contacts: [] };
}
async function saveApolloContacts(
  companyId: number,
  tier: "founder" | "recruiter" | "engineer_referral",
  people: ApolloPerson[]
): Promise<ContactRecord[]> {
  const records: ContactRecord[] = [];
  for (const p of people) {
    const rec = await addContact({
      company_id: companyId,
      name: p.name,
      role: p.title,
      contact_tier: tier,
      profile_url: p.linkedin_url || "",
      email: p.email || undefined,
      email_confidence: p.email_status || (p.email ? "verified" : undefined),
      source: "apollo",
    });
    records.push(rec);
  }
  return records;
}
