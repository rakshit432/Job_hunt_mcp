export interface ProspeoResult {
  email: string | null;
  email_status: "VERIFIED" | "UNVERIFIED" | null;
  name?: string;
  title?: string;
}

/**
 * Calls Prospeo.io LinkedIn Email Finder API.
 * Free tier provides 75 free searches/month.
 * Endpoint: POST https://api.prospeo.io/linkedin-email-finder
 */
export async function findEmailViaProspeo(linkedinUrl: string): Promise<ProspeoResult | null> {
  const apiKey = process.env.PROSPEO_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const res = await fetch("https://api.prospeo.io/linkedin-email-finder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KEY": apiKey,
      },
      body: JSON.stringify({
        url: linkedinUrl,
      }),
    });

    if (!res.ok) {
      console.warn(`Prospeo API returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = (await res.json()) as {
      error: boolean;
      message?: string;
      response?: {
        email?: string;
        email_status?: "VERIFIED" | "UNVERIFIED";
        full_name?: string;
        title?: string;
      };
    };

    if (json.error || !json.response) {
      return null;
    }

    // Only return strictly VERIFIED emails
    if (json.response.email && json.response.email_status === "VERIFIED") {
      return {
        email: json.response.email,
        email_status: "VERIFIED",
        name: json.response.full_name,
        title: json.response.title,
      };
    }

    return null;
  } catch (err) {
    console.warn("Prospeo lookup failed:", (err as Error).message);
    return null;
  }
}

