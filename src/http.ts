import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createJobHuntServer } from "./index.js";
import { initDb } from "./db/client.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Track active client SSE transports by sessionId
const activeTransports = new Map<string, SSEServerTransport>();

// Optional API key authorization (set AUTH_TOKEN in .env/environment to protect your server)
const AUTH_TOKEN = process.env.AUTH_TOKEN;

app.use((req, res, next) => {
  // CORS support
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }

  // If AUTH_TOKEN is configured, verify Bearer token or ?token= query param
  if (AUTH_TOKEN) {
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

// Health check endpoint for cloud platforms (Railway, Render, AWS, Fly.io)
app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "job-hunt-mcp",
    version: "1.0.0",
    activeSessions: activeTransports.size,
  });
});

// SSE endpoint: Claude connects here via GET
app.get("/sse", async (req, res) => {
  console.log(`[SSE] New client connection request from ${req.ip}`);

  // Create SSE transport directing POST messages to /messages
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);

  // Each client connection gets its own McpServer instance
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

// Message endpoint: Claude sends tool requests here via POST
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

  await transport.handlePostMessage(req, res);
});

async function start() {
  try {
    await initDb();
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Warning: Database initialization error:", err);
  }

  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Job-Hunt MCP Server running in Remote HTTP Mode`);
    console.log(`Port:     ${PORT}`);
    console.log(`Health:   http://localhost:${PORT}/health`);
    console.log(`SSE URL:  http://localhost:${PORT}/sse`);
    console.log(`==================================================\n`);
  });
}

start();

