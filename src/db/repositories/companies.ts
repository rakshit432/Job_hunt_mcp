import { pool } from "../client.js";
import { assertTransition, type Status } from "../../services/statusMachine.js";
import { UserFacingError } from "../../errors.js";

export type ChecklistFilter =
  | "all"
  | "new"
  | "drafted"
  | "sent"
  | "followup_due";

export async function listChecklist(filter: ChecklistFilter) {
  let where = "";
  if (filter === "followup_due") {
    where = `WHERE c.status = 'sent' AND EXISTS (
      SELECT 1 FROM outreach o
      WHERE o.company_id = c.id AND o.status = 'sent' AND o.follow_up_on <= CURRENT_DATE
    )`;
  } else if (filter !== "all") {
    where = "WHERE c.status = $1";
  }

  const sql = `
    SELECT c.id, c.name, c.funding_round, c.funding_date, c.score, c.status, c.team_size,
           (SELECT MAX(o.sent_at) FROM outreach o WHERE o.company_id = c.id) AS last_contacted
    FROM companies c
    ${where}
    ORDER BY c.funding_date DESC, c.id DESC
    LIMIT 100`;

  const params = filter === "all" || filter === "followup_due" ? [] : [filter];
  const { rows } = await pool.query(sql, params);
  return rows;
}

const FOLLOWUP_DAYS = Number(process.env.FOLLOWUP_AFTER_DAYS ?? 6);

export async function updateCompanyStatus(companyId: number, to: Status) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row so two requests can't change it at the same time
    const cur = await client.query(
      "SELECT status FROM companies WHERE id = $1 FOR UPDATE",
      [companyId]
    );
    if (cur.rowCount === 0) {
      throw new UserFacingError(`Company ${companyId} not found.`);
    }

    const from = cur.rows[0].status as Status;
    try {
      assertTransition(from, to);
    } catch (e) {
      throw new UserFacingError((e as Error).message);
    }

    await client.query("UPDATE companies SET status = $1 WHERE id = $2", [to, companyId]);

    if (to === "sent") {
      const upd = await client.query(
        `UPDATE outreach
         SET status = 'sent', sent_at = NOW(), follow_up_on = CURRENT_DATE + $2::int
         WHERE id = (SELECT id FROM outreach
                     WHERE company_id = $1 AND status = 'drafted'
                     ORDER BY id DESC LIMIT 1)`,
        [companyId, FOLLOWUP_DAYS]
      );
      if (upd.rowCount === 0) {
        // No draft exists yet (draft_email comes in Step 6), so record one
        await client.query(
          `INSERT INTO outreach (company_id, kind, status, sent_at, follow_up_on)
           VALUES ($1, 'initial', 'sent', NOW(), CURRENT_DATE + $2::int)`,
          [companyId, FOLLOWUP_DAYS]
        );
      }
    }

    if (to === "replied" || to === "no_response") {
      await client.query(
        `UPDATE outreach
         SET status = $2::text,
             replied_at = CASE WHEN $2::text = 'replied' THEN NOW() ELSE replied_at END
         WHERE id = (SELECT id FROM outreach
                     WHERE company_id = $1 AND status = 'sent'
                     ORDER BY id DESC LIMIT 1)`,
        [companyId, to]
      );
    }

    const res = await client.query(
      `SELECT c.id, c.name, c.status,
              (SELECT MAX(o.follow_up_on) FROM outreach o WHERE o.company_id = c.id) AS follow_up_on
       FROM companies c WHERE c.id = $1`,
      [companyId]
    );

    await client.query("COMMIT");
    return res.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function saveDraft(
  companyId: number,
  contactId: number | undefined,
  renderEmail: (
    company: { id: number; name: string; funding_round: string | null },
    contactName: string | null
  ) => { subject: string; body: string }
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query(
      "SELECT id, name, funding_round, status FROM companies WHERE id = $1 FOR UPDATE",
      [companyId]
    );
    if (cur.rowCount === 0) {
      throw new UserFacingError(`Company ${companyId} not found.`);
    }

    const company = cur.rows[0];
    if (!["new", "drafted", "no_response"].includes(company.status)) {
      throw new UserFacingError(
        `Cannot draft email for company in status '${company.status}'. Allowed only for 'new', 'drafted', or 'no_response'.`
      );
    }

    let contact: { id: number; name: string; email: string } | null = null;
    if (contactId) {
      const cRes = await client.query(
        "SELECT id, name, email FROM contacts WHERE id = $1 AND company_id = $2",
        [contactId, companyId]
      );
      if (cRes.rowCount === 0) {
        throw new UserFacingError(
          `Contact ${contactId} not found for company ${companyId}.`
        );
      }
      contact = cRes.rows[0];
    } else {
      const cRes = await client.query(
        "SELECT id, name, email FROM contacts WHERE company_id = $1 ORDER BY id ASC LIMIT 1",
        [companyId]
      );
      if (cRes.rowCount && cRes.rowCount > 0) {
        contact = cRes.rows[0];
      }
    }

    const { subject, body } = renderEmail(company, contact?.name ?? null);

    if (company.status !== "drafted") {
      await client.query("UPDATE companies SET status = 'drafted' WHERE id = $1", [
        companyId,
      ]);
    }

    const existingDraft = await client.query(
      "SELECT id FROM outreach WHERE company_id = $1 AND status = 'drafted' ORDER BY id DESC LIMIT 1",
      [companyId]
    );

    let outreachId: number;
    if (existingDraft.rowCount && existingDraft.rowCount > 0) {
      outreachId = existingDraft.rows[0].id;
      await client.query(
        `UPDATE outreach
         SET contact_id = $2, subject = $3, body = $4
         WHERE id = $1`,
        [outreachId, contact?.id ?? null, subject, body]
      );
    } else {
      const ins = await client.query(
        `INSERT INTO outreach (company_id, contact_id, kind, subject, body, status)
         VALUES ($1, $2, 'initial', $3, $4, 'drafted')
         RETURNING id`,
        [companyId, contact?.id ?? null, subject, body]
      );
      outreachId = ins.rows[0].id;
    }

    await client.query("COMMIT");

    return {
      outreach_id: outreachId,
      company_id: company.id,
      company_name: company.name,
      contact_id: contact?.id ?? null,
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      subject,
      body,
      status: "drafted",
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface IngestCompanyInput {
  name: string;
  website?: string;
  domain?: string;
  description?: string;
  location?: string;
  remote_friendly?: boolean;
  team_size?: number;
  funding_round?: string;
  funding_amount?: string;
  funding_date?: string; // YYYY-MM-DD
  source_url?: string;
  score?: number;
}

function extractDomain(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function ingestCompany(input: IngestCompanyInput) {
  const normalized = input.name.toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  const domain = input.domain || extractDomain(input.website);
  const fundingDate = input.funding_date || new Date().toISOString().slice(0, 10);

  const sql = `
    INSERT INTO companies (
      name, name_normalized, website, domain, description, location,
      remote_friendly, team_size, funding_round, funding_amount,
      funding_date, source_url, score, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, 'new')
    ON CONFLICT (name_normalized, funding_date) DO UPDATE
    SET website = COALESCE(EXCLUDED.website, companies.website),
        domain = COALESCE(EXCLUDED.domain, companies.domain),
        team_size = COALESCE(EXCLUDED.team_size, companies.team_size),
        description = COALESCE(EXCLUDED.description, companies.description),
        score = COALESCE(EXCLUDED.score, companies.score)
    RETURNING *`;

  const { rows } = await pool.query(sql, [
    input.name,
    normalized,
    input.website ?? null,
    domain,
    input.description ?? null,
    input.location ?? null,
    input.remote_friendly ?? false,
    input.team_size ?? null,
    input.funding_round ?? null,
    input.funding_amount ?? null,
    fundingDate,
    input.source_url ?? null,
    input.score ?? null,
  ]);

  return rows[0];
}

export async function getCompanyDetails(companyId: number) {
  const compRes = await pool.query("SELECT * FROM companies WHERE id = $1", [companyId]);
  if (compRes.rowCount === 0) {
    throw new UserFacingError(`Company ${companyId} not found.`);
  }

  const contactsRes = await pool.query(
    "SELECT * FROM contacts WHERE company_id = $1 ORDER BY id ASC",
    [companyId]
  );
  const outreachRes = await pool.query(
    "SELECT * FROM outreach WHERE company_id = $1 ORDER BY id DESC",
    [companyId]
  );

  return {
    company: compRes.rows[0],
    contacts: contactsRes.rows,
    outreach_history: outreachRes.rows,
  };
}