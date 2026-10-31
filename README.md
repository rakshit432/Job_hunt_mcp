# Job Hunt MCP Server 🚀

An automated cold outreach and internship hunting engine built on the **Model Context Protocol (MCP)**, **Apollo.io**, **Firecrawl**, and **PostgreSQL (Supabase)**.

Custom-built for tech cold outreach to newly funded startups, hiring managers, and referral engineers.

---

## 🌟 Key Features

1. **Funding Radar**: Scrapes funding announcements, VC portfolios, and tech venture news (Inc42, YourStory, Entrackr, Peak XV, Blume Ventures) via **Firecrawl**.
2. **Tiered Contact Discovery**:
   - **Company Size $\le 50$**: Finds Founders, Co-Founders, and CTOs.
   - **Company Size $> 50$**: Finds Technical Recruiters, Talent Acquisition Leads, and Engineering Managers.
   - **Fallback**: Finds Lead Software Engineers and Senior SWEs for internal referrals.
3. **Verified Email Extraction**:
   - Primary: **Apollo.io** for real, verified B2B email addresses and LinkedIn profiles.
   - Fallback: Corporate domain pattern prediction (`first@domain`, `first.last@domain`).
4. **Cold Outreach Drafting**:
   - Personalized email builder targeting software engineering, backend, and GenAI roles.
   - Injects company focus, observation, and personal credentials.
5. **Pessimistic State Machine**:
   - Enforces linear pipeline stages: `new` $\rightarrow$ `drafted` $\rightarrow$ `sent` $\rightarrow$ `replied` / `no_response`.
   - Never sends emails automatically: creates drafts for your personal review and records follow-up dates.

---

## 🛠️ MCP Tools Overview

| Tool | Purpose |
|---|---|
| `scrape_funding_deals` | Scrapes VC portfolios or funding articles via Firecrawl to discover fresh startups. |
| `ingest_company` | Adds a newly discovered company with its `team_size`, website, and funding details to the DB. |
| `discover_contacts` | Runs Apollo.io / Firecrawl tiered contact search (Founders vs Recruiters vs Referral SWEs). |
| `get_company_details`| Retrieves company dossier: profile, discovered contacts, and outreach history/drafts. |
| `list_checklist` | Lists tracked companies filtered by status (`new`, `drafted`, `sent`, `followup_due`). |
| `draft_email` | Generates a personalized cold email draft from your template and saves it to DB. |
| `update_status` | Advances pipeline status (e.g. mark as `sent` after you personally send the email). |

---

## ⚙️ Setup & Configuration

### 1. Environment Variables (`.env`)
Create or edit `.env` in the `job-hunt-mcp/` directory:

```env
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxxxxxx
APOLLO_API_KEY=your_apollo_api_key_here
FOLLOWUP_AFTER_DAYS=6
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Tests
```bash
npm test
```

### 4. Build & Run

```bash
# Local stdio mode (Claude Desktop)
npm run dev

# Remote HTTP / SSE server mode (for cloud hosting)
npm run start:http

# Production Build
npm run build
npm start
```

---

## ☁️ Remote HTTP / SSE Deployment (Deploy to Railway / Render)

You can deploy this server to the cloud so anyone can connect to it via URL without installing Node.js:

1. Push this repository to GitHub.
2. Link it to **[Railway.app](https://railway.app)** or **[Render.com](https://render.com)**.
3. Set your environment variables in their dashboard (`DATABASE_URL`, `FIRECRAWL_API_KEY`, `APOLLO_API_KEY`, and optional `AUTH_TOKEN`).
4. Connect from Claude Desktop using the public URL:
   ```json
   {
     "mcpServers": {
       "job-hunt": {
         "url": "https://your-app.up.railway.app/sse"
       }
     }
   }
   ```

---

## 🔌 Connecting to Local MCP Clients

### Claude Desktop / Cursor / Antigravity Settings
Add the server configuration to your MCP config JSON:

```json
{
  "mcpServers": {
    "job-hunt": {
      "command": "node",
      "args": [
        "c:/Users/BIT/Desktop/mcp_project/job-hunt-mcp/dist/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "FIRECRAWL_API_KEY": "fc-...",
        "APOLLO_API_KEY": "..."
      }
    }
  }
}
```

---

## 📋 Typical Workflow

```
1. scrape_funding_deals(url="https://inc42.com/buzz/indian-startup-funding-tracker/")
        ↓
2. ingest_company(name="Acme AI", team_size=15, website="https://acme.ai", funding_round="Seed")
        ↓
3. discover_contacts(company_id=1)  # Automatically finds Founders & verified emails via Apollo
        ↓
4. draft_email(company_id=1, focus="LLM agent orchestration", observation="the fast inference speed")
        ↓
5. Review draft → You send it from your personal Gmail
        ↓
6. update_status(company_id=1, status="sent")  # Sets follow-up reminder for 6 days later
```

