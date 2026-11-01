import { SCHEMA } from "./schema.js";

export const MIGRATIONS = [
  {
    version: 1,
    name: "baseline_schema",
    // Idempotent baseline also brings existing installations up to the current base schema.
    sql: SCHEMA,
  },
  {
    version: 2,
    name: "unique_company_contact_emails",
    sql: `
      WITH groups AS (
        SELECT company_id, LOWER(email) AS normalized_email, MIN(id) AS keep_id
        FROM contacts WHERE email IS NOT NULL
        GROUP BY company_id, LOWER(email)
      ), duplicate_links AS (
        SELECT c.id, g.keep_id
        FROM contacts c JOIN groups g
          ON c.company_id = g.company_id AND LOWER(c.email) = g.normalized_email
        WHERE c.id <> g.keep_id
      )
      UPDATE outreach o
      SET contact_id = d.keep_id
      FROM duplicate_links d
      WHERE o.contact_id = d.id;

      WITH merged AS (
        SELECT company_id, LOWER(email) AS normalized_email, MIN(id) AS keep_id,
               (ARRAY_AGG(name ORDER BY (name IS NULL), id))[1] AS name,
               (ARRAY_AGG(role ORDER BY (role IS NULL), id))[1] AS role,
               (ARRAY_AGG(contact_tier ORDER BY (contact_tier IS NULL), id))[1] AS contact_tier,
               (ARRAY_AGG(email_confidence ORDER BY (email_confidence IS NULL), id))[1] AS email_confidence,
               (ARRAY_AGG(profile_url ORDER BY (profile_url IS NULL), id))[1] AS profile_url,
               (ARRAY_AGG(source ORDER BY (source IS NULL), id))[1] AS source
        FROM contacts
        WHERE email IS NOT NULL
        GROUP BY company_id, LOWER(email)
      )
      UPDATE contacts keep
      SET name = COALESCE(keep.name, m.name),
          role = COALESCE(keep.role, m.role),
          contact_tier = COALESCE(keep.contact_tier, m.contact_tier),
          email_confidence = COALESCE(keep.email_confidence, m.email_confidence),
          profile_url = COALESCE(keep.profile_url, m.profile_url),
          source = COALESCE(keep.source, m.source)
      FROM merged m
      WHERE keep.id = m.keep_id;

      WITH groups AS (
        SELECT company_id, LOWER(email) AS normalized_email, MIN(id) AS keep_id
        FROM contacts WHERE email IS NOT NULL
        GROUP BY company_id, LOWER(email)
      )
      DELETE FROM contacts c USING groups g
      WHERE c.company_id = g.company_id AND LOWER(c.email) = g.normalized_email AND c.id <> g.keep_id;

      CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_email_unique
      ON contacts (company_id, LOWER(email))
      WHERE email IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: "correct_email_confidence_labels",
    sql: `
      UPDATE contacts
      SET email_confidence = CASE
        WHEN source = 'ingest_company' THEN 'provided'
        ELSE 'published'
      END
      WHERE email_confidence = 'verified'
        AND source IN ('ingest_company', 'company_website', 'mca_registry', 'accelerator_portfolio', 'startup_directory');
    `,
  },
] as const;
