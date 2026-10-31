import { UserFacingError } from "../errors.js";

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";

function getApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new UserFacingError(
      "FIRECRAWL_API_KEY is not set in .env. Please get an API key from https://firecrawl.dev and add it to your .env file."
    );
  }
  return key;
}

export interface ScrapedPage {
  markdown: string;
  title?: string;
  description?: string;
}

export interface SearchResultItem {
  title: string;
  description: string;
  url: string;
}

/**
 * Scrapes a single webpage (e.g. funding announcement, VC portfolio, tech news)
 * and returns clean markdown.
 */
export async function scrapeUrl(url: string): Promise<ScrapedPage> {
  const apiKey = getApiKey();

  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new UserFacingError(`Firecrawl scrape failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as {
    success: boolean;
    data?: {
      markdown?: string;
      metadata?: { title?: string; description?: string };
    };
    error?: string;
  };

  if (!json.success || !json.data) {
    throw new UserFacingError(json.error || "Failed to scrape URL via Firecrawl.");
  }

  return {
    markdown: json.data.markdown || "",
    title: json.data.metadata?.title,
    description: json.data.metadata?.description,
  };
}

/**
 * Searches the web via Firecrawl Search API to discover LinkedIn profiles,
 * team members, or specific roles.
 */
export async function searchPeople(query: string, limit = 5): Promise<SearchResultItem[]> {
  const apiKey = getApiKey();

  const response = await fetch(`${FIRECRAWL_API_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new UserFacingError(`Firecrawl search failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as {
    success: boolean;
    data?: Array<{ title?: string; description?: string; url?: string }>;
    error?: string;
  };

  if (!json.success || !json.data) {
    throw new UserFacingError(json.error || "Failed to search people via Firecrawl.");
  }

  return json.data.map((item) => ({
    title: item.title || "",
    description: item.description || "",
    url: item.url || "",
  }));
}

