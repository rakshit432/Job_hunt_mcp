import { UserFacingError } from "../errors.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

function getApolloKey(): string | null {
  return process.env.APOLLO_API_KEY || null;
}

function cleanDomain(input: string): string {
  try {
    const url = input.startsWith("http") ? input : `https://${input}`;
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase().trim();
  } catch {
    return input.replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0].toLowerCase().trim();
  }
}

export interface ApolloPerson {
  id?: string;
  name: string;
  first_name: string;
  last_name: string;
  title: string;
  email: string | null;
  email_status: string | null;
  linkedin_url: string | null;
  organization_name?: string;
  organization_estimated_num_employees?: number;
}

/**
 * Enriches a person profile to reveal their real verified corporate email via Apollo /people/match.
 */
export async function enrichPersonViaApollo(
  firstName?: string,
  lastName?: string,
  domainOrName?: string,
  linkedinUrl?: string
): Promise<{ email: string | null; email_status: string | null }> {
  const apiKey = getApolloKey();
  if (!apiKey) return { email: null, email_status: null };

  const body: Record<string, unknown> = {
    reveal_personal_emails: false,
  };

  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (domainOrName && domainOrName.includes(".")) {
    body.domain = cleanDomain(domainOrName);
  }
  if (linkedinUrl) {
    body.linkedin_url = linkedinUrl;
  }

  try {
    const res = await fetchWithTimeout(`${APOLLO_API_BASE}/people/match`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Apollo /people/match failed with status ${res.status}.`);
      return { email: null, email_status: null };
    }

    const data = (await res.json()) as {
      person?: {
        email?: string;
        email_status?: string;
      };
    };

    return {
      email: data.person?.email || null,
      email_status: data.person?.email_status || null,
    };
  } catch (err) {
    console.error("Apollo enrichPerson failed:", err);
    return { email: null, email_status: null };
  }
}

/**
 * Searches for people at a company matching specific target job titles,
 * and enriches them with real verified work emails directly through Apollo.io.
 */
export async function searchPeopleViaApollo(
  domainOrName: string,
  targetTitles: string[],
  limit = 5
): Promise<ApolloPerson[]> {
  const apiKey = getApolloKey();
  if (!apiKey) {
    throw new UserFacingError("APOLLO_API_KEY is not configured in the server environment variables.");
  }

  const isDomain = domainOrName.includes(".");
  const body: Record<string, unknown> = {
    person_titles: targetTitles,
    page: 1,
    per_page: limit,
  };

  if (isDomain) {
    // Apollo requires q_organization_domains to be an ARRAY of clean domain strings
    body.q_organization_domains = [cleanDomain(domainOrName)];
  } else {
    body.q_organization_name = domainOrName.trim();
  }

  try {
    // Try modern api_search endpoint first, fall back to search
    let res = await fetchWithTimeout(`${APOLLO_API_BASE}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok && res.status === 404) {
      res = await fetchWithTimeout(`${APOLLO_API_BASE}/mixed_people/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      console.error(`Apollo search failed with status ${res.status}.`);
      throw new UserFacingError(`Apollo search failed (${res.status}).`);
    }

    const data = (await res.json()) as {
      people?: Array<{
        id?: string;
        name?: string;
        first_name?: string;
        last_name?: string;
        title?: string;
        email?: string;
        email_status?: string;
        linkedin_url?: string;
        organization?: {
          name?: string;
          estimated_num_employees?: number;
        };
      }>;
    };

    if (!data.people || data.people.length === 0) {
      return [];
    }

    const results: ApolloPerson[] = [];

    for (const p of data.people) {
      let email = p.email || null;
      let email_status = p.email_status || null;

      // Enrich via Apollo /people/match to retrieve real verified corporate email
      if (!email && (p.first_name || p.linkedin_url)) {
        const enriched = await enrichPersonViaApollo(
          p.first_name,
          p.last_name,
          domainOrName,
          p.linkedin_url || undefined
        );
        if (enriched.email && enriched.email_status) {
          email = enriched.email;
          email_status = enriched.email_status;
        }
      }

      results.push({
        id: p.id,
        name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
        first_name: p.first_name || "",
        last_name: p.last_name || "",
        title: p.title || "Team Member",
        email,
        email_status,
        linkedin_url: p.linkedin_url || null,
        organization_name: p.organization?.name,
        organization_estimated_num_employees: p.organization?.estimated_num_employees,
      });
    }

    return results;
  } catch (err) {
    if (err instanceof UserFacingError) {
      throw err;
    }
    console.error("Apollo search failed:", err);
    throw new UserFacingError(`Apollo API connection error: ${(err as Error).message}`);
  }
}
