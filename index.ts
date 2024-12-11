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
import { exec } from "node:child_process";
import { promisify } from "node:util";
import robotsParser from "robots-parser";
import sharp from "sharp";

const execAsync = promisify(exec);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Image {
  src: string;
  alt: string;
  data?: Buffer;
}

interface ExtractedContent {
  markdown: string;
  images: Image[];
}

const DEFAULT_USER_AGENT_AUTONOMOUS =
  "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const DEFAULT_USER_AGENT_MANUAL =
  "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)";

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

  // Extract images from the article content only
  const articleDom = new JSDOM(article.content);
  const imgElements = Array.from(
    articleDom.window.document.querySelectorAll("img")
  );

  const images: Image[] = imgElements.map((img) => {
    const src = img.src;
    const alt = img.alt || "";
    return { src, alt };
  });

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndownService.turndown(article.content);

  return { markdown, images };
}

async function fetchImages(
  images: Image[]
): Promise<(Image & { data: Buffer })[]> {
  const fetchedImages = [];
  for (const img of images) {
    const response = await fetch(img.src);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch image ${img.src}: status ${response.status}`
      );
    }
    const buffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);

    // Check if the image is a GIF and extract first frame if animated
    if (img.src.toLowerCase().endsWith(".gif")) {
      try {
        const metadata = await sharp(imageBuffer).metadata();
        if (metadata.pages && metadata.pages > 1) {
          // Extract first frame of animated GIF
          const firstFrame = await sharp(imageBuffer, { page: 0 })
            .png()
            .toBuffer();
          fetchedImages.push({
            ...img,
            data: firstFrame,
          });
          continue;
        }
      } catch (error) {
        console.warn(`Warning: Failed to process GIF image ${img.src}:`, error);
      }
    }

    fetchedImages.push({
      ...img,
      data: imageBuffer,
    });
  }
  return fetchedImages;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

async function getImageDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number; size: number }> {
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    size: buffer.length,
  };
}

async function addImagesToClipboard(
  images: (Image & { data: Buffer })[]
): Promise<void> {
  if (images.length === 0) return;

  const hasPbcopy = await commandExists("pbcopy");
  const hasOsascript = await commandExists("osascript");
  if (!hasPbcopy) {
    throw new Error(
      "'pbcopy' command not found. This tool works on macOS only by default."
    );
  }
  if (!hasOsascript) {
    throw new Error(
      "'osascript' command not found. Required to set clipboard with images."
    );
  }

  const MAX_HEIGHT = 8000;
  const MAX_SIZE_BYTES = 30 * 1024 * 1024; // 30MB
  const MAX_IMAGES_PER_GROUP = 6; // 1グループあたりの最大画像数

  const tempDir = "/tmp/mcp-fetch-images";
  await execAsync(`mkdir -p ${tempDir} && rm -f ${tempDir}/*.png`);

  // 画像をグループ化して処理
  let currentGroup: Buffer[] = [];
  let currentHeight = 0;
  let currentSize = 0;

  const processGroup = async (group: Buffer[]) => {
    if (group.length === 0) return;

    // 垂直方向に画像を結合
    const mergedImagePath = `${tempDir}/merged_${Date.now()}.png`;
    await sharp({
      create: {
        width: Math.max(
          ...(await Promise.all(
            group.map(async (buffer) => {
              const metadata = await sharp(buffer).metadata();
              return metadata.width || 0;
            })
          ))
        ),
        height: (
          await Promise.all(
            group.map(async (buffer) => {
              const metadata = await sharp(buffer).metadata();
              return metadata.height || 0;
            })
          )
        ).reduce((a, b) => a + b, 0),
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite(
        await Promise.all(
          group.map(async (buffer, index) => {
            const previousHeights = await Promise.all(
              group.slice(0, index).map(async (b) => {
                const metadata = await sharp(b).metadata();
                return metadata.height || 0;
              })
            );
            const top = previousHeights.reduce((a, b) => a + b, 0);
            return {
              input: buffer,
              top,
              left: 0,
            };
          })
        )
      )
      .png()
      .toFile(mergedImagePath);

    const { stderr } = await execAsync(
      `osascript -e 'set the clipboard to (read (POSIX file "${mergedImagePath}") as «class PNGf»)'`
    );
    if (stderr?.trim()) {
      const lines = stderr.trim().split("\n");
      const nonWarningLines = lines.filter(
        (line) => !line.includes("WARNING:")
      );
      if (nonWarningLines.length > 0) {
        throw new Error("Failed to copy merged image to clipboard.");
      }
    }

    await sleep(500);
    const pasteScript = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
    const { stderr: pasteStderr } = await execAsync(pasteScript);
    if (pasteStderr?.trim()) {
      const lines = pasteStderr.trim().split("\n");
      const nonWarningLines = lines.filter(
        (line) => !line.includes("WARNING:")
      );
      if (nonWarningLines.length > 0) {
        console.warn("Failed to paste merged image.");
      }
    }
    await sleep(500);
  };

  for (const img of images) {
    const { height, size } = await getImageDimensions(img.data);

    if (
      currentGroup.length >= MAX_IMAGES_PER_GROUP ||
      currentHeight + height > MAX_HEIGHT ||
      currentSize + size > MAX_SIZE_BYTES
    ) {
      // 現在のグループを処理
      await processGroup(currentGroup);
      // 新しいグループを開始
      currentGroup = [img.data];
      currentHeight = height;
      currentSize = size;
    } else {
      currentGroup.push(img.data);
      currentHeight += height;
      currentSize += size;
    }
  }

  // 残りのグループを処理
  await processGroup(currentGroup);

  await execAsync(`rm -rf ${tempDir}`);
}

async function checkRobotsTxt(
  url: string,
  userAgent: string
): Promise<boolean> {
  const { protocol, host } = new URL(url);
  const robotsUrl = `${protocol}//${host}/robots.txt`;

  const response = await fetch(robotsUrl);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Autonomous fetching not allowed based on robots.txt response"
      );
    }
    return true; // Allow if no robots.txt
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
}

interface FetchResult {
  content: string;
  prefix: string;
  imageUrls?: string[];
}

async function fetchUrl(
  url: string,
  userAgent: string,
  forceRaw = false
): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} - status code ${response.status}`);
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
    const imageUrls = fetchedImages.map((img) => img.src);

    if (fetchedImages.length > 0) {
      try {
        await addImagesToClipboard(fetchedImages);
        return {
          content: markdown,
          prefix: `Found and processed ${fetchedImages.length} images. Images have been merged vertically (max 6 images per group) and copied to your clipboard. Please paste (Cmd+V) to combine with the retrieved content.\n`,
          imageUrls,
        };
      } catch (err) {
        return {
          content: markdown,
          prefix: `Found ${fetchedImages.length} images but failed to copy them to the clipboard.\nError: ${err instanceof Error ? err.message : String(err)}\n`,
          imageUrls,
        };
      }
    }
    return {
      content: markdown,
      prefix: "",
      imageUrls,
    };
  }

  return {
    content: text,
    prefix: `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`,
  };
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
          "Retrieves URLs from the Internet and extracts their content as markdown. If images are found, they are merged vertically (max 6 images per group, max height 8000px, max size 30MB per group) and copied to the clipboard of the user's host machine. You will need to paste (Cmd+V) to insert the images.",
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

      const { content, prefix, imageUrls } = await fetchUrl(
        parsed.data.url,
        DEFAULT_USER_AGENT_AUTONOMOUS,
        parsed.data.raw
      );

      let finalContent = content;
      if (finalContent.length > parsed.data.maxLength) {
        finalContent = finalContent.slice(
          parsed.data.startIndex,
          parsed.data.startIndex + parsed.data.maxLength
        );
        finalContent += `\n\n<e>Content truncated. Call the fetch tool with a start_index of ${
          parsed.data.startIndex + parsed.data.maxLength
        } to get more content.</e>`;
      }

      let imagesSection = "";
      if (imageUrls && imageUrls.length > 0) {
        imagesSection =
          "\n\nImages found in article:\n" +
          imageUrls.map((url) => `- ${url}`).join("\n");
      }

      return {
        content: [
          {
            type: "text",
            text: `${prefix}Contents of ${parsed.data.url}:\n${finalContent}${imagesSection}`,
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
}

runServer().catch((error) => {
  process.stderr.write(`Fatal error running server: ${error}\n`);
  process.exit(1);
});
