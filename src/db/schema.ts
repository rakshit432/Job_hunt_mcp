export const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  description TEXT,
  location TEXT,
  remote_friendly BOOLEAN DEFAULT FALSE,
  team_size INTEGER,
  funding_round TEXT,
  funding_amount TEXT,
  funding_date DATE NOT NULL,
  source_url TEXT,
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (name_normalized, funding_date)
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT,
  role TEXT,
  contact_tier TEXT,
  email TEXT,
  email_confidence TEXT,
  profile_url TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS outreach (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  kind TEXT NOT NULL,
  template_variant TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  follow_up_on DATE,
  replied_at TIMESTAMPTZ
);

-- Ensure newly added columns exist in existing databases
ALTER TABLE companies ADD COLUMN IF NOT EXISTS team_size INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_tier TEXT;
`;
