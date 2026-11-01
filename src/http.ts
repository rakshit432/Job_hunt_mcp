import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createJobHuntServer } from "./index.js";
import { checkDbReady, initDb, pool } from "./db/client.js";
import { UserFacingError } from "./errors.js";
import {
  listChecklist,
  ingestCompany,
  updateCompanyProfile,
  getCompanyDetails,
  updateCompanyStatus,
  saveDraft,
  type ChecklistFilter,
} from "./db/repositories/companies.js";
import { discoverAllCompanyEmails, discoverAndSaveContacts } from "./services/contactDiscovery.js";
import { scrapeUrl } from "./services/firecrawl.js";
import { buildEmail } from "./services/templating.js";
import {
  ChecklistFilterSchema,
  BulkDiscoverySchema,
  CompanyIdSchema,
  DraftEmailSchema,
  IngestCompanySchema,
  ScrapeSchema,
  UpdateProfileSchema,
  UpdateStatusSchema,
} from "./validation.js";

function parseBody<T>(schema: ZodType<T>, body: unknown, res: express.Response): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return undefined;
  }
  return parsed.data;
}

const app = express();
const PORT = process.env.PORT || 3000;
app.disable("x-powered-by");

// Track active client SSE transports by sessionId
const activeTransports = new Map<string, SSEServerTransport>();

// Bearer-token authorization for all stateful routes.
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const CORS_ORIGINS = new Set((process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
const requestBuckets = new Map<string, { start: number; count: number }>();

app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Vary", "Origin");

  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  if (AUTH_TOKEN && !["/", "/health", "/ready", "/openapi.json"].includes(req.path)) {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const expected = Buffer.from(AUTH_TOKEN);
    const received = Buffer.from(bearer);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const expensiveRoute = ["/messages", "/api/discover-contacts", "/api/discover-all-contacts", "/api/scrape"].includes(req.path);
  if (expensiveRoute) {
    const now = Date.now();
    const identity = req.headers.authorization || req.ip || "anonymous";
    const key = createHash("sha256").update(identity).digest("hex");
    const bucket = requestBuckets.get(key);
    const windowMs = 60_000;
    const limit = req.path === "/messages" ? 30 : req.path === "/api/discover-all-contacts" ? 2 : 6;
    if (!bucket || now - bucket.start >= windowMs) {
      requestBuckets.set(key, { start: now, count: 1 });
    } else if (bucket.count >= limit) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      res.status(429).json({ error: "Rate limit exceeded", request_id: requestId });
      return;
    } else {
      bucket.count += 1;
    }
    if (requestBuckets.size > 10_000) {
      for (const [bucketKey, value] of requestBuckets) {
        if (now - value.start >= windowMs) requestBuckets.delete(bucketKey);
      }
    }
  }

  next();
});

app.use(express.json({ limit: "256kb" }));

function sendRouteError(res: express.Response, error: unknown): void {
  const requestId = String(res.getHeader("X-Request-Id") ?? "unknown");
  if (error instanceof UserFacingError) {
    res.status(400).json({ error: error.message, request_id: requestId });
    return;
  }
  console.error(`[request ${requestId}]`, error);
  res.status(500).json({ error: "Internal server error", request_id: requestId });
}

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
        <li>/api/checklist &mdash; View the pipeline (requires a bearer token)</li>
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
  });
});

app.get("/ready", async (_req, res) => {
  try {
    await checkDbReady();
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not_ready" });
  }
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
        url: process.env.PUBLIC_BASE_URL || "https://job-hunt-mcp.onrender.com",
        description: "Job-Hunt API",
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
                    emails: { type: "array", items: { type: "string", format: "email" } },
                    contacts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" }, role: { type: "string" },
                          contact_tier: { type: "string", enum: ["founder", "recruiter", "engineer_referral", "other"] },
                          email: { type: "string", format: "email" }, profile_url: { type: "string", format: "uri" },
                          email_confidence: { type: "string" }, source: { type: "string" },
                        },
                      },
                    },
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
      "/api/discover-all-contacts": {
        post: {
          operationId: "discoverContactsBatch",
          summary: "Discover contacts for a bounded batch of companies",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
                    offset: { type: "integer", minimum: 0, default: 0 },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Batch results, failures, and next offset" } },
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
    const parsedFilter = ChecklistFilterSchema.safeParse(req.query.filter ?? "all");
    if (!parsedFilter.success) {
      res.status(400).json({ error: "Invalid filter", issues: parsedFilter.error.issues });
      return;
    }
    const filter = parsedFilter.data as ChecklistFilter;
    const rows = await listChecklist(filter);
    res.json(rows);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get("/api/company/:id", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id, 10);
    const parsed = CompanyIdSchema.safeParse({ company_id: companyId });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid company id", issues: parsed.error.issues });
      return;
    }
    const details = await getCompanyDetails(companyId);
    res.json(details);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/ingest", async (req, res) => {
  try {
    const input = parseBody(IngestCompanySchema, req.body, res);
    if (!input) return;
    const company = await ingestCompany(input);
    res.json(company);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/update-profile", async (req, res) => {
  try {
    const input = parseBody(UpdateProfileSchema, req.body, res);
    if (!input) return;
    const { company_id, website, domain, team_size } = input;
    const updated = await updateCompanyProfile(company_id, { website, domain, team_size });
    res.json(updated);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/discover-contacts", async (req, res) => {
  try {
    const input = parseBody(CompanyIdSchema, req.body, res);
    if (!input) return;
    const companyId = input.company_id;
    const result = await discoverAndSaveContacts(companyId);
    res.json(result);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/discover-all-contacts", async (req, res) => {
  try {
    const input = parseBody(BulkDiscoverySchema, req.body ?? {}, res);
    if (!input) return;
    const result = await discoverAllCompanyEmails(input.limit, input.offset);
    res.json(result);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/draft-email", async (req, res) => {
  try {
    const input = parseBody(DraftEmailSchema, req.body, res);
    if (!input) return;
    const { company_id, contact_id, focus, observation } = input;
    const draft = await saveDraft(company_id, contact_id, (company, contactName) =>
      buildEmail(company, contactName, focus, observation)
    );
    res.json(draft);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/update-status", async (req, res) => {
  try {
    const input = parseBody(UpdateStatusSchema, req.body, res);
    if (!input) return;
    const { company_id, status } = input;
    const updated = await updateCompanyStatus(company_id, status);
    res.json(updated);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post("/api/scrape", async (req, res) => {
  try {
    const input = parseBody(ScrapeSchema, req.body, res);
    if (!input) return;
    const { url } = input;
    const page = await scrapeUrl(url);
    res.json(page);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = String(res.getHeader("X-Request-Id") ?? "unknown");
  const parseError = error as { status?: number; type?: string };
  if (parseError.status === 400 || parseError.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON request body", request_id: requestId });
    return;
  }
  if (parseError.status === 413 || parseError.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large", request_id: requestId });
    return;
  }
  sendRouteError(res, error);
});

// ==========================================
// 6. Server Initialization
// ==========================================
async function start() {
  await initDb();
  await checkDbReady();
  console.log("Database initialized and ready.");

  const server = app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Job-Hunt MCP & REST Server running on port ${PORT}`);
    console.log(`Home:      http://localhost:${PORT}/`);
    console.log(`MCP SSE:   http://localhost:${PORT}/sse`);
    console.log(`OpenAPI:   http://localhost:${PORT}/openapi.json`);
    console.log(`Health:    http://localhost:${PORT}/health`);
    console.log(`Readiness: http://localhost:${PORT}/ready`);
    console.log(`==================================================\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; closing server.`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error) => {
  console.error("Server startup failed; refusing to accept traffic.", error);
  process.exitCode = 1;
});
