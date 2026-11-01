export interface SnovResult {
  email: string | null;
  email_status: "verified" | null;
  name?: string;
}

let cachedSnovToken: { token: string; expiresAt: number } | null = null;

async function getSnovAccessToken(): Promise<string | null> {
  const clientId = process.env.SNOV_CLIENT_ID;
  const clientSecret = process.env.SNOV_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  // Use cached token if valid
  if (cachedSnovToken && Date.now() < cachedSnovToken.expiresAt) {
    return cachedSnovToken.token;
  }

  try {
    const res = await fetch("https://api.snov.io/v1/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      console.warn(`Snov.io auth failed (${res.status}): ${await res.text()}`);
      return null;
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      return null;
    }

    cachedSnovToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ? (data.expires_in - 60) * 1000 : 3600 * 1000),
    };

    return cachedSnovToken.token;
  } catch (err) {
    console.warn("Snov.io token request error:", (err as Error).message);
    return null;
  }
}

/**
 * Calls Snov.io API to get emails from a LinkedIn profile URL.
 * Free tier provides 50 free credits/month.
 */
export async function findEmailViaSnov(linkedinUrl: string): Promise<SnovResult | null> {
  const token = await getSnovAccessToken();
  if (!token) {
    return null;
  }

  try {
    const res = await fetch("https://api.snov.io/v1/get-emails-from-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: linkedinUrl,
        access_token: token,
      }),
    });

    if (!res.ok) {
      console.warn(`Snov.io lookup returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = (await res.json()) as {
      success?: boolean;
      data?: {
        firstName?: string;
        lastName?: string;
        emails?: Array<{
          email?: string;
          status?: string; // "valid" | "catch_all" | "unknown"
        }>;
      };
    };

    if (!json.success || !json.data?.emails) {
      return null;
    }

    // Only accept strictly "valid" emails (no catch-all or unverified guesses)
    const validEmail = json.data.emails.find((e) => e.status === "valid" && e.email);
    if (!validEmail || !validEmail.email) {
      return null;
    }

    const fullName = [json.data.firstName, json.data.lastName].filter(Boolean).join(" ");

    return {
      email: validEmail.email,
      email_status: "verified",
      name: fullName || undefined,
    };
  } catch (err) {
    console.warn("Snov.io email lookup error:", (err as Error).message);
    return null;
  }
}

