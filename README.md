# Job Hunt MCP Server

A local-first job search and startup outreach tracker built with TypeScript, the Model Context Protocol (MCP), PostgreSQL, Apollo, and Firecrawl. It can run as a local stdio server for Claude Desktop or as an authenticated HTTP/SSE service.

The server discovers and stores companies and contacts, tracks outreach, and creates email drafts for review. **It never sends email.** It does not guess email addresses.

## What it does

- Scrapes funding and company pages with Firecrawl.
- Stores company profiles, email addresses, and structured contact records.
- Searches Apollo first, then uses configured discovery providers and public sources as fallbacks.
- Labels provider-verified addresses `verified`; addresses found on public pages are labeled `published`; user-entered addresses are labeled `provided`.
- Creates personalized drafts from `data/template.md` and tracks status and follow-up dates.

## MCP tools

| Tool | Purpose |
|---|---|
| `scrape_funding_deals` | Scrape a URL and return its title and Markdown. |
| `ingest_company` | Add or update a company, direct email addresses, and structured contacts. |
| `update_company_profile` | Update a company’s website, domain, or team size. |
| `discover_contacts` | Search for contacts and save discovered email addresses for one company. |
| `discover_all_company_emails` | Discover contacts in batches; defaults to 25 companies and accepts up to 100 per call. Use `next_offset` to continue. |
| `get_company_details` | Return a company profile, contacts, and outreach history. |
| `list_checklist` | List companies by pipeline status or due follow-up. |
| `update_status` | Advance a company through the outreach status flow. Mark `sent` only after you send the email yourself. |
| `draft_email` | Create or replace an outreach draft. It does not send it. |

`ingest_company` accepts `emails` for company inboxes and `contacts` for people. A contact can include `name`, `role`, `contact_tier`, `email`, `email_confidence`, `profile_url`, and `source`. Email and profile URL are optional. For example:

```json
{
  "name": "Acme AI",
  "website": "https://acme.ai",
  "team_size": 15,
  "funding_round": "Seed",
  "emails": ["hello@acme.ai"],
  "contacts": [
    {
      "name": "Taylor Example",
      "role": "Founder",
      "contact_tier": "founder",
      "email": "taylor@acme.ai",
      "email_confidence": "provided",
      "profile_url": "https://www.linkedin.com/in/taylor-example",
      "source": "manual"
    }
  ]
}
```

## Run locally with Claude Desktop

### 1. Configure environment

Create `C:\Users\BIT\Desktop\mcp_project\job-hunt-mcp\.env` with your PostgreSQL URL and provider keys:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
FIRECRAWL_API_KEY=your-firecrawl-key
APOLLO_API_KEY=your-apollo-key
PROSPEO_API_KEY=your-prospeo-key
SNOV_CLIENT_ID=your-snov-client-id
SNOV_CLIENT_SECRET=your-snov-client-secret
FOLLOWUP_AFTER_DAYS=6

```

Provider keys beyond `DATABASE_URL` are optional, but contact discovery will have fewer sources without them. PostgreSQL connections use TLS with certificate verification disabled to support database providers whose certificate chain is not trusted by Node.js.

### 2. Build the server

In PowerShell:

```powershell
cd C:\Users\BIT\Desktop\mcp_project\job-hunt-mcp
npm ci
npm run build
```

### 3. Add the server to Claude Desktop

Open Claude Desktop **Settings → Developer → Edit Config**. Add this entry to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "job-hunt": {
      "command": "node",
      "args": [
        "C:/Users/BIT/Desktop/mcp_project/job-hunt-mcp/dist/index.js"
      ]
    }
  }
}
```

Save the file, fully quit Claude Desktop, and reopen it. The server loads `.env` from the project directory when it starts. If Claude Desktop already has an `mcpServers` object, add the `job-hunt` entry inside it rather than replacing the other servers.

The first successful startup applies pending database migrations. After connecting, try `ingest_company`, then `discover_contacts` or `draft_email`.

## Run tests

```powershell
npm test
```

## HTTP/SSE deployment

The HTTP server is for hosted deployments. In production, set:

```env
NODE_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
# Optional. When set, protected HTTP routes require Authorization: Bearer <token>.
# AUTH_TOKEN=
FIRECRAWL_API_KEY=your-firecrawl-key
APOLLO_API_KEY=your-apollo-key
CORS_ORIGINS=https://your-approved-browser-origin.example
PUBLIC_BASE_URL=https://your-service.example
PORT=3000
```

`AUTH_TOKEN` is optional. When it is unset, HTTP routes do not require a bearer token; when set, send it as `Authorization: Bearer <token>`. `/health` is a public liveness endpoint, `/ready` checks database connectivity, and `/openapi.json` publishes the REST API description. Set `CORS_ORIGINS` to a comma-separated list of exact browser origins, or leave it empty if browser access is not needed.

Run the compiled HTTP server with:

```powershell
npm run build
npm start
```

The Docker image uses Node 24, runs as a non-root user, and checks `/ready`. If `AUTH_TOKEN` is configured, hosted MCP clients must send it in their HTTP headers. Store secrets in the hosting provider’s secret manager, not in the repository.

## Status flow

```text
new → drafted → sent → replied
                   ↘ no_response → drafted
```

Companies can also be marked `skipped` or `rejected` where allowed by the status rules. The server records drafts and follow-up dates but does not send messages.
