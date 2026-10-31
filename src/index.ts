#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initDb } from "./db/client.js";
import {
  listChecklist,
  saveDraft,
  updateCompanyStatus,
  ingestCompany,
  updateCompanyProfile,
  getCompanyDetails,
} from "./db/repositories/companies.js";
import { STATUSES } from "./services/statusMachine.js";
import { buildEmail } from "./services/templating.js";
import { scrapeUrl } from "./services/firecrawl.js";
import { discoverAndSaveContacts } from "./services/contactDiscovery.js";
import { UserFacingError } from "./errors.js";

export function registerTools(server: McpServer) {
  // ---------- Tool 1: scrape_funding_deals ----------
  server.registerTool(
    "scrape_funding_deals",
    {
      description:
        "Scrapes a webpage containing funding announcements, VC portfolios, or startup venture news (e.g. Inc42, YourStory, Entrackr, Blume, Peak XV) using Firecrawl, returning clean markdown content to discover new funded startups.",
      inputSchema: {
        url: z.string().url(),
      },
    },
    async ({ url }) => {
      try {
        const page = await scrapeUrl(url);
        return {
          content: [
            {
              type: "text",
              text: `Title: ${page.title || "Untitled"}\n\n${page.markdown}`,
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("scrape_funding_deals failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to scrape funding page. Check server logs." }],
        };
      }
    }
  );

  // ---------- Tool 2: ingest_company ----------
  server.registerTool(
    "ingest_company",
    {
      description:
        "Save a newly discovered funded startup into the database. Tracks team_size, funding details, and website so contact discovery and cold outreach can be automated.",
      inputSchema: {
        name: z.string().min(1),
        team_size: z.number().int().positive().optional(),
        website: z.string().optional(),
        domain: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        remote_friendly: z.boolean().optional(),
        funding_round: z.string().optional(),
        funding_amount: z.string().optional(),
        funding_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        source_url: z.string().optional(),
        score: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        const company = await ingestCompany(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(company, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("ingest_company failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Could not ingest company. Check server logs." }],
        };
      }
    }
  );

  // ---------- Tool 3: update_company_profile ----------
  server.registerTool(
    "update_company_profile",
    {
      description:
        "Update an existing company's website, domain, or team size by its company_id. Use this when a company has no website/domain so Apollo can match real verified contacts.",
      inputSchema: {
        company_id: z.number().int().positive(),
        website: z.string().optional(),
        domain: z.string().optional(),
        team_size: z.number().int().positive().optional(),
      },
    },
    async ({ company_id, website, domain, team_size }) => {
      try {
        const updated = await updateCompanyProfile(company_id, {
          website,
          domain,
          team_size,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(updated, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("update_company_profile failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Could not update company profile. Check server logs." }],
        };
      }
    }
  );

  // ---------- Tool 4: discover_contacts ----------
  server.registerTool(
    "discover_contacts",
    {
      description:
        "Finds verified hiring decision-makers and contacts exclusively via Apollo.io. Follows hiring strategy: (1) If company size <= 50, finds Founders/CTO. (2) If size > 50, finds Technical Recruiters / Talent Acquisition. (3) Fallback: finds Lead/Senior Software Engineers for referrals. Discovered contacts and verified work emails are automatically enriched and saved to the database.",
      inputSchema: {
        company_id: z.number().int().positive(),
      },
    },
    async ({ company_id }) => {
      try {
        const result = await discoverAndSaveContacts(company_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("discover_contacts failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : "Contact discovery failed. Check server logs." }],
        };
      }
    }
  );

  // ---------- Tool 5: get_company_details ----------
  server.registerTool(
    "get_company_details",
    {
      description:
        "Retrieve full details for a company: company profile, all discovered contacts, and outreach history/drafts.",
      inputSchema: {
        company_id: z.number().int().positive(),
      },
    },
    async ({ company_id }) => {
      try {
        const details = await getCompanyDetails(company_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("get_company_details failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Could not fetch company details. Check server logs." }],
        };
      }
    }
  );

  // ---------- Tool 6: list_checklist ----------
  server.registerTool(
    "list_checklist",
    {
      description:
        "List companies in the job-hunt tracker with their status. Use this before drafting any email to check whether a company was already contacted. filter: new, drafted, sent, followup_due (sent and past follow-up date), or all.",
      inputSchema: {
        filter: z
          .enum(["all", "new", "drafted", "sent", "followup_due"])
          .default("all"),
      },
    },
    async ({ filter }) => {
      try {
        const rows = await listChecklist(filter);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      } catch (err) {
        console.error("list_checklist failed:", err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Could not read the checklist. Check the server logs.",
            },
          ],
        };
      }
    }
  );

  // ---------- Tool 7: update_status ----------
  server.registerTool(
    "update_status",
    {
      description:
        "Change a company's pipeline status. Flow: new -> drafted -> sent -> replied or no_response. new and drafted can also go to skipped; any active status can go to rejected. Use 'sent' only after the USER confirms they sent the email themselves; this server never sends email. Invalid jumps are rejected with an explanation of what is allowed.",
      inputSchema: {
        company_id: z.number().int().positive(),
        status: z.enum(STATUSES),
      },
    },
    async ({ company_id, status }) => {
      try {
        const row = await updateCompanyStatus(company_id, status);
        return {
          content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return {
            isError: true,
            content: [{ type: "text", text: err.message }],
          };
        }
        console.error("update_status failed:", err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Could not update the status. Check the server logs.",
            },
          ],
        };
      }
    }
  );

  // ---------- Tool 8: draft_email ----------
  server.registerTool(
    "draft_email",
    {
      description:
        "Create an outreach email DRAFT for a company from the user's template and save it. This never sends anything; the user reviews and sends it themselves. Allowed only for companies with status new, drafted (replaces the draft), or no_response after cooldown. Check list_checklist first. 'focus' is the specific product, technology or initiative of the company; 'observation' is one thing the user liked about it. Use ONLY facts the user gave you or that are stored for the company. Never invent them. If you have no real facts, omit both and a generic opening is used.",
      inputSchema: {
        company_id: z.number().int().positive(),
        contact_id: z.number().int().positive().optional(),
        focus: z.string().min(5).max(120).optional(),
        observation: z.string().min(5).max(200).optional(),
      },
    },
    async ({ company_id, contact_id, focus, observation }) => {
      try {
        const draft = await saveDraft(company_id, contact_id, (company, contactName) =>
          buildEmail(company, contactName, focus, observation)
        );
        const note = focus
          ? ""
          : "\n\nNote: a generic opening line was used because no specific product details were provided. Suggest the user personalize it.";
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(draft, null, 2) +
                note +
                "\n\nDRAFT ONLY. Show this to the user to review. Do not claim it was sent.",
            },
          ],
        };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        console.error("draft_email failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Could not create the draft. Check the server logs." }],
        };
      }
    }
  );
}

export function createJobHuntServer(): McpServer {
  const server = new McpServer({ name: "job-hunt", version: "1.0.0" });
  registerTools(server);
  return server;
}

// ---------- Start (stdio mode) ----------
async function main() {
  const server = createJobHuntServer();
  await server.connect(new StdioServerTransport());
  console.error("job-hunt MCP server running on stdio");
  try {
    await initDb();
    console.error("Database schema initialized successfully");
  } catch (err) {
    console.error("Warning: Database initialization error:", err);
  }
}

const isDirectRun =
  process.argv[1]?.replace(/\\/g, "/").endsWith("index.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("index.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
