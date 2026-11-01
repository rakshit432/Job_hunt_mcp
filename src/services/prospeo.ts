export interface ProspeoResult {
  email: string | null;
  email_status: "VERIFIED" | "UNVERIFIED" | null;
  name?: string;
  title?: string;
}

/**
 * Calls Prospeo.io /enrich-person API (new endpoint as of 2024).
 * Free tier: 75 credits/month. Credits only consumed when email is found.
 * Docs: https://prospeo.io/api-docs
 */
export async function findEmailViaProspeo(linkedinUrl: string): Promise<ProspeoResult | null> {
  const apiKey = process.env.PROSPEO_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.prospeo.io/enrich-person", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KEY": apiKey,
      },
      body: JSON.stringify({
        only_verified_email: true,
        enrich_mobile: false,
        data: { linkedin_url: linkedinUrl },
      }),
    });

    if (!res.ok) {
      console.warn(`Prospeo /enrich-person returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = (await res.json()) as {
      req_status?: boolean;
      error_code?: string;
      response?: {
        email?: string;
        email_status?: "VERIFIED" | "UNVERIFIED";
        full_name?: string;
        job_title?: string;
      };
    };

    if (!json.req_status || !json.response?.email) return null;
    if (json.response.email_status !== "VERIFIED") return null;

    return {
      email: json.response.email,
      email_status: "VERIFIED",
      name: json.response.full_name,
      title: json.response.job_title,
    };
  } catch (err) {
    console.warn("Prospeo lookup failed:", (err as Error).message);
    return null;
  }
}
