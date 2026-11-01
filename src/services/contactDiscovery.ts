import type { ApolloPerson } from "./apollo.js";
import { runApolloWaterfall } from "./apolloWaterfall.js";
import { findEmailViaProspeo } from "./prospeo.js";
import { findEmailViaSnov } from "./snov.js";
import { searchPeople, fetchEmailsFromCompanyWebsite } from "./firecrawl.js";
import { scrapeMcaMasterData, scrapeAcceleratorPortfolios, scrapeStartupDirectories } from "./registryDiscovery.js";
import { addContact, addCompanyEmails, type ContactRecord } from "../db/repositories/contacts.js";
import { pool } from "../db/client.js";
import { listCompaniesForEmailDiscovery } from "../db/repositories/companies.js";

function parseLinkedInTitle(rawTitle: string): { name: string; role: string } {
  const cleaned = rawTitle.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const parts = cleaned.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) return { name: parts[0].trim(), role: parts[1].trim() };
  return { name: cleaned || "Team Member", role: "Team Member" };
}

/**
 * Discovers company-specific emails using a 6-layer zero-prediction waterfall.
 * Only records contacts that have a real email address.
 */
export async function discoverAndSaveContacts(companyId: number): Promise<{
  tier: string;
  source: string;
  contacts: ContactRecord[];
  diagnostics: Record<string, string>;
}> {
  const diag: Record<string, string> = {};

  const { rows } = await pool.query(
    "SELECT id, name, domain, team_size FROM companies WHERE id = $1",
    [companyId]
  );

  if (rows.length === 0) {
    return { tier: "", source: "", contacts: [], diagnostics: { error: `Company ID ${companyId} not found` } };
  }

  const company = rows[0];
  const domainOrName = company.domain || company.name;

  diag["company"] = company.name;
  diag["domain"] = company.domain || "NOT SET";

  if (!domainOrName) {
    return { tier: "", source: "", contacts: [], diagnostics: { error: "No name or domain on company record" } };
  }

  const teamSize = company.team_size ?? 0;
  const isSmallStartup = teamSize <= 50;
  let activeTier: "founder" | "recruiter" | "engineer_referral" = isSmallStartup ? "founder" : "recruiter";

  // ── 1️⃣ Apollo ───────────────────────────────────────────────────────────────
  const apollo = await runApolloWaterfall(domainOrName, teamSize);
  Object.assign(diag, apollo.diagnostics);
  activeTier = apollo.tier;
  if (apollo.people.length > 0) {
    diag["winner"] = "apollo";
    const saved = await saveApolloContacts(companyId, activeTier, apollo.people);
    return { tier: activeTier, source: "apollo", contacts: saved, diagnostics: diag };
  }

  // ── 2️⃣ Firecrawl LinkedIn search + Prospeo / Snov waterfall ───────────────
  diag["prospeo_key"] = process.env.PROSPEO_API_KEY ? "SET" : "MISSING ❌";
  diag["snov_client_id"] = process.env.SNOV_CLIENT_ID ? "SET" : "MISSING ❌";
  diag["snov_client_secret"] = process.env.SNOV_CLIENT_SECRET ? "SET" : "MISSING ❌";

  try {
    const query = isSmallStartup
      ? `site:linkedin.com/in "${company.name}" (Founder OR "Co-Founder" OR CTO OR CEO)`
      : `site:linkedin.com/in "${company.name}" ("Technical Recruiter" OR "Engineering Manager" OR "Head of Talent")`;

    const searchHits = await searchPeople(query, 5);
    const validHits = searchHits.filter((h) => h.url?.includes("linkedin.com/in/"));
    diag["linkedin_search"] = validHits.length > 0
      ? `${validHits.length} profiles found`
      : "0 LinkedIn profiles found";

    if (validHits.length > 0) {
      const savedContacts: ContactRecord[] = [];
      for (const hit of validHits) {
        const { name, role } = parseLinkedInTitle(hit.title);
        let email: string | undefined;
        let emailConfidence: string | undefined;
        let contactSource = "linkedin_directory";

        // Prospeo
        try {
          const prospeoRes = await findEmailViaProspeo(hit.url);
          if (prospeoRes?.email && prospeoRes.email_status === "VERIFIED") {
            email = prospeoRes.email;
            emailConfidence = "verified";
            contactSource = "prospeo";
            diag[`prospeo:${name}`] = "verified email found";
          } else {
            diag[`prospeo:${name}`] = "no verified email returned";
          }
        } catch (e) {
          diag[`prospeo:${name}`] = `ERROR: ${(e as Error).message}`;
        }

        // Snov.io fallback
        if (!email) {
          try {
            const snovRes = await findEmailViaSnov(hit.url);
            if (snovRes?.email && snovRes.email_status === "verified") {
              email = snovRes.email;
              emailConfidence = "verified";
              contactSource = "snov";
              diag[`snov:${name}`] = "verified email found";
            } else {
              diag[`snov:${name}`] = "no verified email returned";
            }
          } catch (e) {
            diag[`snov:${name}`] = `ERROR: ${(e as Error).message}`;
          }
        }

        if (email) {
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
      }

      if (savedContacts.length > 0) {
        diag["winner"] = "prospeo/snov";
        return {
          tier: activeTier,
          source: "verified_waterfall",
          contacts: savedContacts,
          diagnostics: diag,
        };
      }

      diag["linkedin_search"] = `${diag["linkedin_search"]}; no verified emails found`;
    }
  } catch (err) {
    diag["linkedin_search"] = `ERROR: ${(err as Error).message}`;
  }

  // ── 3️⃣ Company homepage scrape ──────────────────────────────────────────────
  if (company.domain) {
    try {
      const emails = await fetchEmailsFromCompanyWebsite(company.domain, 10);
      diag["homepage_scrape"] = emails.length > 0 ? `${emails.length} published emails found` : "no emails found";
      if (emails.length > 0) {
        const saved = await addCompanyEmails(companyId, emails, {
          role: "Company Website Email",
          contact_tier: activeTier,
          profile_url: company.domain,
          source: "company_website",
          email_confidence: "published",
        });
        diag["winner"] = "company_website";
        return { tier: activeTier, source: "company_website", contacts: saved, diagnostics: diag };
      }
    } catch (err) {
      diag["homepage_scrape"] = `ERROR: ${(err as Error).message}`;
    }
  } else {
    diag["homepage_scrape"] = "SKIPPED — no domain set on company record";
  }

  // ── 4️⃣ MCA Registry ─────────────────────────────────────────────────────────
  try {
    const mcaContacts = await scrapeMcaMasterData(company.name);
    const emailContacts = mcaContacts.filter((c) => c.email);
    diag["mca_registry"] = emailContacts.length > 0 ? `${emailContacts.length} email contacts found` : "no email results";
    if (emailContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of emailContacts) {
        saved.push(await addContact({ company_id: companyId, name: c.name, role: c.role, contact_tier: "founder", profile_url: c.sourceUrl, email: c.email, email_confidence: "published", source: "mca_registry" }));
      }
      diag["winner"] = "mca_registry";
      return { tier: "founder", source: "mca_registry", contacts: saved, diagnostics: diag };
    }
  } catch (err) {
    diag["mca_registry"] = `ERROR: ${(err as Error).message}`;
  }

  // ── 5️⃣ Accelerator portfolios ───────────────────────────────────────────────
  try {
    const portContacts = await scrapeAcceleratorPortfolios(company.name);
    const emailContacts = portContacts.filter((c) => c.email);
    diag["accelerator"] = emailContacts.length > 0 ? `${emailContacts.length} email contacts found` : "no email results";
    if (emailContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of emailContacts) {
        saved.push(await addContact({ company_id: companyId, name: c.name, role: c.role, contact_tier: "founder", profile_url: c.sourceUrl, email: c.email, email_confidence: "published", source: "accelerator_portfolio" }));
      }
      diag["winner"] = "accelerator_portfolio";
      return { tier: "founder", source: "accelerator_portfolio", contacts: saved, diagnostics: diag };
    }
  } catch (err) {
    diag["accelerator"] = `ERROR: ${(err as Error).message}`;
  }

  // ── 6️⃣ Startup directories ──────────────────────────────────────────────────
  try {
    const dirContacts = await scrapeStartupDirectories(company.name);
    const emailContacts = dirContacts.filter((c) => c.email);
    diag["startup_directories"] = emailContacts.length > 0 ? `${emailContacts.length} email contacts found` : "no email results";
    if (emailContacts.length > 0) {
      const saved: ContactRecord[] = [];
      for (const c of emailContacts) {
        saved.push(await addContact({ company_id: companyId, name: c.name, role: c.role, contact_tier: activeTier, profile_url: c.sourceUrl, email: c.email, email_confidence: "published", source: "startup_directory" }));
      }
      diag["winner"] = "startup_directory";
      return { tier: activeTier, source: "startup_directory", contacts: saved, diagnostics: diag };
    }
  } catch (err) {
    diag["startup_directories"] = `ERROR: ${(err as Error).message}`;
  }

  diag["winner"] = "NONE — all sources exhausted";
  return { tier: "", source: "", contacts: [], diagnostics: diag };
}

export async function discoverAllCompanyEmails(limit = 25, offset = 0): Promise<{
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  processed: number;
  companies_with_emails: number;
  total_emails_saved: number;
  failures: number;
  results: Array<{
    company_id: number;
    company_name: string;
    source: string | null;
    emails_found: number;
  }>;
}> {
  const [companies, countResult] = await Promise.all([
    listCompaniesForEmailDiscovery(limit, offset),
    pool.query("SELECT COUNT(*)::int AS total FROM companies"),
  ]);
  const total = countResult.rows[0].total as number;
  const results: Array<{
    company_id: number;
    company_name: string;
    source: string | null;
    emails_found: number;
  }> = [];

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, companies.length) }, async () => {
    while (nextIndex < companies.length) {
      const index = nextIndex++;
      const company = companies[index];
      try {
        const discovered = await discoverAndSaveContacts(company.id);
        results[index] = {
          company_id: company.id,
          company_name: company.name,
          source: discovered.source || null,
          emails_found: discovered.contacts.length,
        };
      } catch (error) {
        console.error(`Contact discovery failed for company ${company.id}:`, error);
        results[index] = {
          company_id: company.id,
          company_name: company.name,
          source: "error",
          emails_found: 0,
        };
      }
    }
  });
  await Promise.all(workers);

  return {
    total,
    limit,
    offset,
    has_more: offset + companies.length < total,
    next_offset: offset + companies.length < total ? offset + companies.length : null,
    processed: companies.length,
    companies_with_emails: results.filter((result) => result.emails_found > 0).length,
    total_emails_saved: results.reduce((sum, result) => sum + result.emails_found, 0),
    failures: results.filter((result) => result.source === "error").length,
    results,
  };
}

async function saveApolloContacts(
  companyId: number,
  tier: "founder" | "recruiter" | "engineer_referral",
  people: ApolloPerson[]
): Promise<ContactRecord[]> {
  const records: ContactRecord[] = [];
  for (const p of people) {
    records.push(await addContact({
      company_id: companyId,
      name: p.name,
      role: p.title,
      contact_tier: tier,
      profile_url: p.linkedin_url || "",
      email: p.email || undefined,
      email_confidence: p.email_status || (p.email ? "verified" : undefined),
      source: "apollo",
    }));
  }
  return records;
}
