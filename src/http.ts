import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createJobHuntServer } from "./index.js";
import { initDb } from "./db/client.js";
import {
  listChecklist,
  ingestCompany,
  updateCompanyProfile,
  getCompanyDetails,
  updateCompanyStatus,
  saveDraft,
  type ChecklistFilter,
} from "./db/repositories/companies.js";
import { discoverAndSaveContacts } from "./services/contactDiscovery.js";
import { scrapeUrl } from "./services/firecrawl.js";
import { buildEmail } from "./services/templating.js";
import { isStatus } from "./services/statusMachine.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Track active client SSE transports by sessionId
const activeTransports = new Map<string, SSEServerTransport>();

// Optional API key authorization (set AUTH_TOKEN in .env/environment to protect your server)
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Enable JSON parser for REST API routes
app.use(express.json());

app.use((req, res, next) => {
  // CORS support for any web browser / web client
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }

  // If AUTH_TOKEN is configured, verify Bearer token or ?token= query param (skip for public docs / health)
  if (AUTH_TOKEN && !["/", "/health", "/openapi.json"].includes(req.path)) {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = req.query.token as string | undefined;

    if (bearer !== AUTH_TOKEN && queryToken !== AUTH_TOKEN) {
      res.status(401).json({ error: "Unauthorized: Invalid or missing AUTH_TOKEN." });
      return;
    }
  }

  next();
});

// ==========================================
// 1. Web Home Dashboard (GET /)
// ==========================================
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Job-Hunt MCP & REST Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); border: 1px solid #334155; }
    h1 { color: #38bdf8; margin-top: 0; font-size: 28px; }
    .badge { display: inline-block; background: #10b981; color: #022c22; padding: 4px 10px; border-radius: 9999px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
    .card { background: #0f172a; padding: 20px; border-radius: 8px; border: 1px solid #334155; margin-bottom: 20px; }
    .card h3 { margin-top: 0; color: #f1f5f9; }
    code { background: #334155; padding: 3px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
    pre { background: #020617; padding: 16px; border-radius: 8px; overflow-x: auto; color: #a5f3fc; border: 1px solid #1e293b; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <span class="badge">● Server Online & Healthy</span>
    <h1>🚀 Job-Hunt MCP & AI Agent Hub</h1>
    <p>This service powers automated startup outreach, Apollo.io contact enrichment, and pipeline tracking across <strong>Claude Desktop, Claude Web, ChatGPT, Cursor, and any web AI</strong>.</p>
    
    <div class="card">
      <h3>🔌 1. For Claude Desktop / Cursor / LibreChat (MCP SSE)</h3>
      <p>Connect using the standard MCP Server-Sent Events (SSE) URL:</p>
      <pre>https://job-hunt-mcp.onrender.com/sse</pre>
    </div>

    <div class="card">
      <h3>🌐 2. For ChatGPT Web / Custom GPTs (OpenAPI Action)</h3>
      <p>Create a Custom GPT in ChatGPT $\to$ <strong>Configure $\to$ Actions $\to$ Import from URL</strong>:</p>
      <pre>https://job-hunt-mcp.onrender.com/openapi.json</pre>
      <p><a href="/openapi.json" target="_blank">View OpenAPI 3.0 Specification JSON &rarr;</a></p>
    </div>

    <div class="card">
      <h3>📊 3. Health & Quick Links</h3>
      <ul>
        <li><a href="/health">/health</a> &mdash; Server status and active sessions</li>
        <li><a href="/api/checklist">/api/checklist</a> &mdash; View current company pipeline</li>
      </ul>
    </div>
  </div>
</body>
</html>
  `);
});

// ==========================================
// 2. Health check endpoint
// ==========================================
app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "job-hunt-mcp",
    version: "1.0.0",
    activeSessions: activeTransports.size,
  });
});

// ==========================================
// 3. MCP SSE Endpoints (Claude Desktop / Cursor / LibreChat)
// ==========================================
app.get("/sse", async (req, res) => {
  console.log(`[SSE] New client connection request from ${req.ip}`);

  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);

  const server = createJobHuntServer();

  transport.onclose = () => {
    console.log(`[SSE] Session closed: ${sessionId}`);
    activeTransports.delete(sessionId);
  };

  try {
    await server.connect(transport);
    console.log(`[SSE] Session connected successfully: ${sessionId}`);
  } catch (err) {
    console.error(`[SSE] Failed to connect session ${sessionId}:`, err);
    activeTransports.delete(sessionId);
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).send("Missing sessionId query parameter.");
    return;
  }

  const transport = activeTransports.get(sessionId);
  if (!transport) {
    res.status(404).send("Session not found or already closed.");
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

// ==========================================
// 4. OpenAPI 3.0 Specification (For ChatGPT Actions & Web LLMs)
// ==========================================
app.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.0.0",
    info: {
      title: "Job-Hunt Automation API",
      description: "Automated startup discovery, Apollo.io verified email lookup, and cold outreach tracking.",
      version: "1.0.0",
    },
    servers: [
      {
        url: "https://job-hunt-mcp.onrender.com",
        description: "Live Production Server",
      },
    ],
    paths: {
      "/api/checklist": {
        get: {
          operationId: "listChecklist",
          summary: "List companies in the pipeline",
          description: "Retrieve companies tracked in the database filtered by status.",
          parameters: [
            {
              name: "filter",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["all", "new", "drafted", "sent", "followup_due"], default: "all" },
              description: "Status filter",
            },
          ],
          responses: {
            "200": { description: "Successful response", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } },
          },
        },
      },
      "/api/company/{companyId}": {
        get: {
          operationId: "getCompanyDetails",
          summary: "Get full company profile and contacts",
          parameters: [
            { name: "companyId", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            "200": { description: "Company details" },
          },
        },
      },
      "/api/ingest": {
        post: {
          operationId: "ingestCompany",
          summary: "Add a newly discovered startup",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    website: { type: "string" },
                    domain: { type: "string" },
                    team_size: { type: "integer" },
                    funding_round: { type: "string" },
                    funding_amount: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Company ingested" } },
        },
      },
      "/api/update-profile": {
        post: {
          operationId: "updateCompanyProfile",
          summary: "Update company website and domain",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["company_id"],
                  properties: {
                    company_id: { type: "integer" },
                    website: { type: "string" },
                    domain: { type: "string" },
                    team_size: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Profile updated" } },
        },
      },
      "/api/discover-contacts": {
        post: {
          operationId: "discoverContacts",
          summary: "Find hiring contacts and verified emails on Apollo.io",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["company_id"],
                  properties: {
                    company_id: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Contacts discovered and saved" } },
        },
      },
      "/api/draft-email": {
        post: {
          operationId: "draftEmail",
          summary: "Generate an outreach email draft",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["company_id"],
                  properties: {
                    company_id: { type: "integer" },
                    contact_id: { type: "integer" },
                    focus: { type: "string" },
                    observation: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Draft generated" } },
        },
      },
      "/api/update-status": {
        post: {
          operationId: "updateStatus",
          summary: "Update company pipeline status",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["company_id", "status"],
                  properties: {
                    company_id: { type: "integer" },
                    status: { type: "string", enum: ["new", "drafted", "sent", "replied", "no_response", "rejected", "skipped"] },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Status updated" } },
        },
      },
    },
  });
});

// ==========================================
// 5. REST Endpoints (Usable by Any Web LLM or Custom Webhook)
// ==========================================
app.get("/api/checklist", async (req, res) => {
  try {
    const filter = (req.query.filter as ChecklistFilter) || "all";
    const rows = await listChecklist(filter);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/company/:id", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id, 10);
    const details = await getCompanyDetails(companyId);
    res.json(details);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ingest", async (req, res) => {
  try {
    const company = await ingestCompany(req.body);
    res.json(company);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/update-profile", async (req, res) => {
  try {
    const { company_id, website, domain, team_size } = req.body;
    const updated = await updateCompanyProfile(company_id, { website, domain, team_size });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/discover-contacts", async (req, res) => {
  try {
    const companyId = parseInt(req.body.company_id, 10);
    const result = await discoverAndSaveContacts(companyId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/draft-email", async (req, res) => {
  try {
    const { company_id, contact_id, focus, observation } = req.body;
    const draft = await saveDraft(company_id, contact_id, (company, contactName) =>
      buildEmail(company, contactName, focus, observation)
    );
    res.json(draft);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/update-status", async (req, res) => {
  try {
    const { company_id, status } = req.body;
    if (!isStatus(status)) {
      res.status(400).json({ error: `Invalid status '${status}'` });
      return;
    }
    const updated = await updateCompanyStatus(company_id, status);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scrape", async (req, res) => {
  try {
    const { url } = req.body;
    const page = await scrapeUrl(url);
    res.json(page);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. Server Initialization
// ==========================================
async function start() {
  try {
    await initDb();
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Warning: Database initialization error:", err);
  }

  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Job-Hunt MCP & REST Server running on port ${PORT}`);
    console.log(`Home:      http://localhost:${PORT}/`);
    console.log(`MCP SSE:   http://localhost:${PORT}/sse`);
    console.log(`OpenAPI:   http://localhost:${PORT}/openapi.json`);
    console.log(`Health:    http://localhost:${PORT}/health`);
    console.log(`==================================================\n`);
  });
}

start();
