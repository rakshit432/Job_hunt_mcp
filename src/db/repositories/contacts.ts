import { pool } from "../client.js";
import type { PoolClient } from "pg";

type ContactQueryer = Pick<PoolClient, "query">;

export interface ContactRecord {
  id: number;
  company_id: number;
  name: string | null;
  role: string | null;
  contact_tier: "founder" | "recruiter" | "engineer_referral" | "other" | null;
  email: string | null;
  email_confidence: string | null;
  profile_url: string | null;
  source: string | null;
}

function normalizeEmail(email?: string): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export async function addContact(data: {
  company_id: number;
  name?: string;
  role?: string;
  contact_tier?: "founder" | "recruiter" | "engineer_referral" | "other";
  email?: string;
  email_confidence?: string;
  profile_url?: string;
  source?: string;
}, queryer: ContactQueryer = pool): Promise<ContactRecord> {
  const normalizedEmail = normalizeEmail(data.email);

  if (normalizedEmail) {
    const existing = await queryer.query(
      `INSERT INTO contacts (
         company_id, name, role, contact_tier, email, email_confidence, profile_url, source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, (LOWER(email))) WHERE email IS NOT NULL
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, contacts.name),
         role = COALESCE(EXCLUDED.role, contacts.role),
         contact_tier = COALESCE(EXCLUDED.contact_tier, contacts.contact_tier),
         email_confidence = COALESCE(EXCLUDED.email_confidence, contacts.email_confidence),
         profile_url = COALESCE(EXCLUDED.profile_url, contacts.profile_url),
         source = COALESCE(EXCLUDED.source, contacts.source)
       RETURNING *`,
      [data.company_id, data.name ?? null, data.role ?? null, data.contact_tier ?? null,
        normalizedEmail, data.email_confidence ?? null, data.profile_url ?? null, data.source ?? "firecrawl"]
    );
    return existing.rows[0];
  }

  const sql = `
    INSERT INTO contacts (
      company_id, name, role, contact_tier, email, email_confidence, profile_url, source
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`;

  const { rows } = await queryer.query(sql, [
    data.company_id,
    data.name ?? null,
    data.role ?? null,
    data.contact_tier ?? null,
    normalizedEmail,
    data.email_confidence ?? null,
    data.profile_url ?? null,
    data.source ?? "firecrawl",
  ]);

  return rows[0];
}

export async function addCompanyEmails(
  companyId: number,
  emails: string[],
  options?: {
    role?: string;
    contact_tier?: "founder" | "recruiter" | "engineer_referral" | "other";
    profile_url?: string;
    source?: string;
    email_confidence?: string;
  },
  queryer: ContactQueryer = pool,
): Promise<ContactRecord[]> {
  const uniqueEmails = Array.from(
    new Set(emails.map((email) => normalizeEmail(email)).filter(Boolean))
  ) as string[];

  const saved: ContactRecord[] = [];
  for (const email of uniqueEmails) {
    saved.push(
      await addContact({
        company_id: companyId,
        role: options?.role ?? "Direct Company Email",
        contact_tier: options?.contact_tier ?? "other",
        email,
        email_confidence: options?.email_confidence ?? "published",
        profile_url: options?.profile_url,
        source: options?.source ?? "company_website",
      }, queryer)
    );
  }

  return saved;
}

export async function getContactsByCompany(companyId: number): Promise<ContactRecord[]> {
  const sql = `SELECT * FROM contacts WHERE company_id = $1 ORDER BY id ASC`;
  const { rows } = await pool.query(sql, [companyId]);
  return rows;
}
