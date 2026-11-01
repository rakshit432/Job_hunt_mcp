export interface SnovResult {
  email: string | null;
  email_status: "verified" | null;
  name?: string;
  title?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getSnovToken(): Promise<string | null> {
  const clientId = process.env.SNOV_CLIENT_ID?.trim();
  const clientSecret = process.env.SNOV_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

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
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
}

/**
 * Calls Snov.io's 2-step async LinkedIn enrichment flow:
 *   1. POST /v2/li-profiles-by-urls/start  → task_hash
 *   2. GET  /v2/li-profiles-by-urls/result/{task_hash} (poll until ready, max 10 s)
 *
 * Free tier: 50 credits/month.
 * Docs: https://snov.io/api
 */
export async function findEmailViaSnov(linkedinUrl: string): Promise<SnovResult | null> {
  const token = await getSnovToken();
  if (!token) return null;

  try {
    // ── Step 1: submit URL ──────────────────────────────────────────────────
    const startRes = await fetch("https://api.snov.io/v2/li-profiles-by-urls/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ urls: [linkedinUrl] }),
    });

    if (!startRes.ok) {
      console.warn(`Snov.io start returned ${startRes.status}: ${await startRes.text()}`);
      return null;
    }

    const startData = (await startRes.json()) as { success?: boolean; task_hash?: string };
    if (!startData.success || !startData.task_hash) {
      console.warn("Snov.io start: no task_hash", startData);
      return null;
    }

    const taskHash = startData.task_hash;

    // ── Step 2: poll for result (max 5 attempts × 2 s = 10 s) ───────────────
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));

      const resultRes = await fetch(
        `https://api.snov.io/v2/li-profiles-by-urls/result/${taskHash}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!resultRes.ok) continue;

      const resultData = (await resultRes.json()) as {
        success?: boolean;
        data?: Array<{
          full_name?: string;
          job_title?: string;
          emails?: Array<{ email?: string; status?: string; type?: string }>;
        }>;
      };

      if (!resultData.success || !resultData.data?.length) continue;

      const profile = resultData.data[0];
      // Only return emails marked "valid" and of type "work"
      const workEmail = profile.emails?.find(
        (e) => e.status === "valid" && e.email
      );

      if (!workEmail?.email) continue;

      return {
        email: workEmail.email,
        email_status: "verified",
        name: profile.full_name,
        title: profile.job_title,
      };
    }

    return null; // timed out or no email found
  } catch (err) {
    console.warn("Snov.io lookup failed:", (err as Error).message);
    return null;
  }
}
