/**
 * Quick test: Prospeo + Snov.io with correct 2024 endpoints.
 * Run: npx tsx src/test-email-finders.ts
 */
import "dotenv/config";

// ─── Prospeo ─────────────────────────────────────────────────────────────────
async function testProspeo(linkedinUrl: string) {
  const apiKey = process.env.PROSPEO_API_KEY?.trim();
  if (!apiKey) { console.error("[Prospeo] ❌ PROSPEO_API_KEY not set"); return; }

  console.log(`\n[Prospeo] Testing: ${linkedinUrl}`);
  const res = await fetch("https://api.prospeo.io/enrich-person", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-KEY": apiKey },
    body: JSON.stringify({
      only_verified_email: true,
      enrich_mobile: false,
      data: { linkedin_url: linkedinUrl },
    }),
  });

  console.log(`[Prospeo] HTTP ${res.status}`);
  const json = await res.json();
  console.log("[Prospeo] Response:", JSON.stringify(json, null, 2));
}

// ─── Snov.io ──────────────────────────────────────────────────────────────────
async function getToken(): Promise<string | null> {
  const clientId = process.env.SNOV_CLIENT_ID?.trim();
  const clientSecret = process.env.SNOV_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) { console.error("[Snov] ❌ credentials missing"); return null; }

  const res = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (data.access_token) { console.log("[Snov] ✅ Token obtained"); return data.access_token; }
  console.error("[Snov] ❌ Auth failed:", data);
  return null;
}

async function testSnov(linkedinUrl: string) {
  console.log(`\n[Snov.io] Testing: ${linkedinUrl}`);
  const token = await getToken();
  if (!token) return;

  // Step 1: submit
  const startRes = await fetch("https://api.snov.io/v2/li-profiles-by-urls/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ urls: [linkedinUrl] }),
  });
  const startData = (await startRes.json()) as { success?: boolean; task_hash?: string };
  console.log("[Snov] Start response:", startData);
  if (!startData.task_hash) return;

  // Step 2: poll
  for (let i = 0; i < 5; i++) {
    console.log(`[Snov] Polling (attempt ${i + 1}/5)...`);
    await new Promise((r) => setTimeout(r, 2000));
    const resultRes = await fetch(
      `https://api.snov.io/v2/li-profiles-by-urls/result/${startData.task_hash}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const resultData = await resultRes.json();
    console.log("[Snov] Poll result:", JSON.stringify(resultData, null, 2));
    if ((resultData as any)?.data?.length) break;
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const TEST_URL = "https://www.linkedin.com/in/satyanadella/";

(async () => {
  await testProspeo(TEST_URL);
  await testSnov(TEST_URL);
  console.log("\nDone.");
})();
