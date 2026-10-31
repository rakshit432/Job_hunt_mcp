import { pool } from "../client.js";

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

export async function addContact(data: {
  company_id: number;
  name: string;
  role: string;
  contact_tier?: "founder" | "recruiter" | "engineer_referral" | "other";
  email?: string;
  email_confidence?: string;
  profile_url?: string;
  source?: string;
}): Promise<ContactRecord> {
  const sql = `
    INSERT INTO contacts (
      company_id, name, role, contact_tier, email, email_confidence, profile_url, source
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`;

  const { rows } = await pool.query(sql, [
    data.company_id,
    data.name,
    data.role,
    data.contact_tier ?? null,
    data.email ?? null,
    data.email_confidence ?? null,
    data.profile_url ?? null,
    data.source ?? "firecrawl",
  ]);

  return rows[0];
}

export async function getContactsByCompany(companyId: number): Promise<ContactRecord[]> {
  const sql = `SELECT * FROM contacts WHERE company_id = $1 ORDER BY id ASC`;
  const { rows } = await pool.query(sql, [companyId]);
  return rows;
}

