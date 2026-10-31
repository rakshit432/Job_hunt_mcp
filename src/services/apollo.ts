import { UserFacingError } from "../errors.js";

const APOLLO_API_BASE = "https://api.apollo.io/v1";

function getApolloKey(): string | null {
  return process.env.APOLLO_API_KEY || null;
}

export interface ApolloPerson {
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
 * Searches for people at a company matching specific target job titles.
 * Uses Apollo's mixed_people/search API.
 */

export async function searchPeopleViaApollo(
  domainOrName: string,
  targetTitles: string[],
  limit = 5
): Promise<ApolloPerson[]> {
  const apiKey = getApolloKey();
  if (!apiKey) {
    return [];
  }

  // Determine if domain or company name was passed
  
  const isDomain = domainOrName.includes(".");
  const body: Record<string, unknown> = {
    api_key: apiKey,
    person_titles: targetTitles,
    page: 1,
    per_page: limit,
  };

  if (isDomain) {
    body.q_organization_domains = domainOrName;
  } else {
    body.q_organization_name = domainOrName;
  }

  try {
    const res = await fetch(`${APOLLO_API_BASE}/mixed_people/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Apollo API error: ${res.status} ${await res.text()}`);
      return [];
    }

    const data = (await res.json()) as {
      people?: Array<{
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

    return data.people.map((p) => ({
      name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      first_name: p.first_name || "",
      last_name: p.last_name || "",
      title: p.title || "Team Member",
      email: p.email || null,
      email_status: p.email_status || null,
      linkedin_url: p.linkedin_url || null,
      organization_name: p.organization?.name,
      organization_estimated_num_employees: p.organization?.estimated_num_employees,
    }));
  } catch (err) {
    console.error("Apollo search failed:", err);
    return [];
  }
}

