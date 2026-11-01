import { scrapeUrl, searchPeople } from "./firecrawl.js";

export interface RegistryContact {
  name: string;
  role: string;
  email?: string;
  sourceUrl: string;
  sourceType: "mca_registry" | "accelerator_portfolio" | "startup_directory";
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Clean and filter email addresses (skip generic image/asset artifacts).
 */
function extractCleanEmails(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) || [];
  return Array.from(new Set(matches.map((e) => e.toLowerCase()))).filter(
    (e) => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.includes("sentry")
  );
}

/**
 * 1. Query MCA Public Master Data (ZaubaCorp / TheCompanyCheck)
 * Extracts legal directors, official registered email, and CIN.
 */
export async function scrapeMcaMasterData(companyName: string): Promise<RegistryContact[]> {
  try {
    const query = `site:zaubacorp.com/company OR site:thecompanycheck.com "${companyName}"`;
    const searchHits = await searchPeople(query, 2);

    if (searchHits.length === 0 || !searchHits[0].url) {
      return [];
    }

    const page = await scrapeUrl(searchHits[0].url);
    const text = page.markdown || "";
    const contacts: RegistryContact[] = [];

    // Extract official registered corporate email
    const emails = extractCleanEmails(text);
    const officialEmail = emails.find((e) => !e.includes("zaubacorp") && !e.includes("thecompanycheck"));

    // Extract Directors list (common section in Zauba/Tofler)
    // Matches patterns like "Director: John Doe" or Director tables
    const directorMatches = text.match(/(?:Director|Signatory|Managing Director)\s*[-:]\s*([A-Za-z\s]{3,30})/gi) || [];

    for (const match of directorMatches) {
      const cleanName = match.replace(/(?:Director|Signatory|Managing Director)\s*[-:]\s*/i, "").trim();
      if (cleanName.length > 2) {
        contacts.push({
          name: cleanName,
          role: "Director / Founder",
          email: officialEmail,
          sourceUrl: searchHits[0].url,
          sourceType: "mca_registry",
        });
      }
    }

    // If directors list regex had no table matches, but we found an official company email:
    if (contacts.length === 0 && officialEmail) {
      contacts.push({
        name: `${companyName} Registered Official`,
        role: "Director / Official Contact",
        email: officialEmail,
        sourceUrl: searchHits[0].url,
        sourceType: "mca_registry",
      });
    }

    return contacts;
  } catch (err) {
    console.warn("MCA registry scrape failed:", (err as Error).message);
    return [];
  }
}

/**
 * 2. Query Accelerator & VC Portfolios (Y Combinator, Peak XV, Blume, Accel)
 * High-value identity source for verified founders and leaders.
 */
export async function scrapeAcceleratorPortfolios(companyName: string): Promise<RegistryContact[]> {
  try {
    const query = `(site:ycombinator.com/companies OR site:peakxv.com OR site:blume.vc) "${companyName}"`;
    const searchHits = await searchPeople(query, 2);

    if (searchHits.length === 0 || !searchHits[0].url) {
      return [];
    }

    const hit = searchHits[0];
    const page = await scrapeUrl(hit.url);
    const text = page.markdown || "";

    const contacts: RegistryContact[] = [];
    const emails = extractCleanEmails(text);
    const validEmail = emails.find(
      (e) => !e.includes("ycombinator") && !e.includes("peakxv") && !e.includes("blume.vc")
    );

    // YC pages usually have an "Active Founders" or "Founders" section
    const founderMatches = text.match(/(?:Founder|Co-Founder)\s*[-:\n]\s*([A-Za-z\s]{3,30})/gi) || [];

    for (const match of founderMatches) {
      const cleanName = match.replace(/(?:Founder|Co-Founder)\s*[-:\n]\s*/i, "").trim();
      if (cleanName.length > 2) {
        contacts.push({
          name: cleanName,
          role: "Founder",
          email: validEmail,
          sourceUrl: hit.url,
          sourceType: "accelerator_portfolio",
        });
      }
    }

    return contacts;
  } catch (err) {
    console.warn("Accelerator portfolio scrape failed:", (err as Error).message);
    return [];
  }
}

/**
 * 3. Query Startup Directories (Wellfound, Inc42, Entrackr)
 */
export async function scrapeStartupDirectories(companyName: string): Promise<RegistryContact[]> {
  try {
    const query = `(site:wellfound.com/company OR site:inc42.com/startups OR site:entrackr.com) "${companyName}"`;
    const searchHits = await searchPeople(query, 2);

    if (searchHits.length === 0 || !searchHits[0].url) {
      return [];
    }

    const hit = searchHits[0];
    const page = await scrapeUrl(hit.url);
    const emails = extractCleanEmails(page.markdown || "");

    const validEmail = emails.find(
      (e) => !e.includes("wellfound") && !e.includes("inc42") && !e.includes("entrackr")
    );

    if (validEmail) {
      return [
        {
          name: `${companyName} Leadership`,
          role: "Founder / Executive",
          email: validEmail,
          sourceUrl: hit.url,
          sourceType: "startup_directory",
        },
      ];
    }

    return [];
  } catch (err) {
    console.warn("Startup directory scrape failed:", (err as Error).message);
    return [];
  }
}

