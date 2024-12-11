#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolRequest,
  ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as applescript from "applescript";
import robotsParser from "robots-parser";

interface Image {
  src: string;
  alt: string;
  data?: Buffer;
}

interface ExtractedContent {
  markdown: string;
  images: Image[];
}

// Constants
const DEFAULT_USER_AGENT_AUTONOMOUS =
  "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const DEFAULT_USER_AGENT_MANUAL =
  "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)";

// Schema definitions
const FetchArgsSchema = z.object({
  url: z.string().url(),
  maxLength: z.number().positive().max(1000000).default(20000),
  startIndex: z.number().min(0).default(0),
  raw: z.boolean().default(false),
});

const ListToolsSchema = z.object({
  method: z.literal("tools/list"),
});

const CallToolSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  }),
});

// Utility functions
function extractContentFromHtml(
  html: string,
  url: string
): ExtractedContent | string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    return "<e>Page failed to be simplified from HTML</e>";
  }

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  // Extract and process images before markdown conversion
  const images: Image[] = [];
  const imgElements = Array.from(dom.window.document.querySelectorAll("img"));
  for (const img of imgElements) {
    const src = img.src;
    const alt = img.alt || "";
    if (src) {
      images.push({ src, alt });
    }
  }

  const markdown = turndownService.turndown(article.content);
  return { markdown, images };
}

async function fetchImages(
  images: Image[]
): Promise<(Image & { data: Buffer })[]> {
  const fetchedImages = await Promise.all(
    images.map(async (img) => {
      try {
        const response = await fetch(img.src);
        if (response.ok) {
          const buffer = await response.buffer();
          return {
            ...img,
            data: buffer,
          };
        }
      } catch (error) {
        console.error(`Failed to fetch image ${img.src}:`, error);
      }
      return null;
    })
  );
  return fetchedImages.filter(
    (img): img is Image & { data: Buffer } => img !== null
  );
}

async function addImagesToClipboard(
  images: (Image & { data: Buffer })[]
): Promise<unknown> {
  if (images.length === 0) return;

  const script = `
    tell application "System Events"
      set imageData to {${images
        .map((img) => `«data ${img.data.toString("base64")}»`)
        .join(", ")}}
      set the clipboard to imageData
    end tell
  `;

  return new Promise((resolve, reject) => {
    applescript.execString(script, (err: Error | null, result: unknown) => {
      if (err) {
        console.error("AppleScript error:", err);
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

async function checkRobotsTxt(
  url: string,
  userAgent: string
): Promise<boolean> {
  const { protocol, host } = new URL(url);
  const robotsUrl = `${protocol}//${host}/robots.txt`;

  try {
    const response = await fetch(robotsUrl);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "Autonomous fetching not allowed based on robots.txt response"
        );
      }
      return true; // Allow if robots.txt is not available
    }

    const robotsTxt = await response.text();
    const robots = robotsParser(robotsUrl, robotsTxt);

    if (!robots.isAllowed(url, userAgent)) {
      throw new Error(
        "The site's robots.txt specifies that autonomous fetching is not allowed. " +
          "Try manually fetching the page using the fetch prompt."
      );
    }
    return true;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to check robots.txt: ${error.message}`);
    }
    throw error;
  }
}

interface FetchResult {
  content: string;
  prefix: string;
}

async function fetchUrl(
  url: string,
  userAgent: string,
  forceRaw = false
): Promise<FetchResult> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url} - status code ${response.status}`
      );
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const isHtml =
      text.toLowerCase().includes("<html") || contentType.includes("text/html");

    if (isHtml && !forceRaw) {
      const result = extractContentFromHtml(text, url);
      if (typeof result === "string") {
        return {
          content: result,
          prefix: "",
        };
      }

      const { markdown, images } = result;
      const fetchedImages = await fetchImages(images);
      if (fetchedImages.length > 0) {
        await addImagesToClipboard(fetchedImages);
      }
      return {
        content: markdown,
        prefix:
          fetchedImages.length > 0
            ? `Found and processed ${fetchedImages.length} images. They have been added to your clipboard.\n`
            : "",
      };
    }

    return {
      content: text,
      prefix: `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }
    throw error;
  }
}

// Server setup
const server = new Server(
  {
    name: "mcp-fetch",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool handlers
interface RequestHandlerExtra {
  signal: AbortSignal;
}

server.setRequestHandler(
  ListToolsSchema,
  async (request: { method: "tools/list" }, extra: RequestHandlerExtra) => {
    const tools = [
      {
        name: "fetch",
        description:
          "Fetches a URL from the internet and optionally extracts its contents as markdown.",
        inputSchema: zodToJsonSchema(FetchArgsSchema),
      },
    ];
    return { tools };
  }
);

server.setRequestHandler(
  CallToolSchema,
  async (
    request: {
      method: "tools/call";
      params: { name: string; arguments?: Record<string, unknown> };
    },
    extra: RequestHandlerExtra
  ) => {
    try {
      const { name, arguments: args } = request.params;

      if (name !== "fetch") {
        throw new Error(`Unknown tool: ${name}`);
      }

      const parsed = FetchArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error}`);
      }

      await checkRobotsTxt(parsed.data.url, DEFAULT_USER_AGENT_AUTONOMOUS);

      const { content, prefix } = await fetchUrl(
        parsed.data.url,
        DEFAULT_USER_AGENT_AUTONOMOUS,
        parsed.data.raw
      );

      let finalContent = content;
      if (content.length > parsed.data.maxLength) {
        finalContent = content.slice(
          parsed.data.startIndex,
          parsed.data.startIndex + parsed.data.maxLength
        );
        finalContent += `\n\n<e>Content truncated. Call the fetch tool with a start_index of ${
          parsed.data.startIndex + parsed.data.maxLength
        } to get more content.</e>`;
      }

      return {
        content: [
          {
            type: "text",
            text: `${prefix}Contents of ${parsed.data.url}:\n${finalContent}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Fetch Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
