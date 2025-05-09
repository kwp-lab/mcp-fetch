# MCP Fetch

Model Context Protocol server for fetching web content and processing images. This allows Claude Desktop (or any MCP client) to fetch web content and handle images appropriately.

This repository forks from the [@smithery/mcp-fetch](https://github.com/smithery-ai/mcp-fetch) and replaces the `node-fetch` implementation with the library [node-fetch-native](https://www.npmjs.com/package/node-fetch-native).

The server will use the `http_proxy` and `https_proxy` environment variables to route requests through the proxy server by default if they are set.
You also can set the `MCP_HTTP_PROXY` environment variable to use a different proxy server.

## Available Tools

- `fetch`: Retrieves URLs from the Internet and extracts their content as markdown. If images are found, their URLs will be included in the response.

**Image Processing Specifications:**

Only extract image urls from the article content, and append them to the tool result:

```json
{
  "params": {
    "url": "https://www.example.com/articles/123"
  },
  "response": {
    "content": [
      {
        "type": "text",
        "text": "Contents of https://www.example.com/articles/123:\nHere is the article content\n\nImages found in article:\n- https://www.example.com/1.jpg.webp\n- https://www.example.com/2.jpg.webp\n- https://www.example.com/3.webp"
      }
    ]
  }
}
```

## Quick Start (For Users)

To use this tool with Claude Desktop, simply add the following to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "tools": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@kwp-lab/mcp-fetch"],
      "env": {
        "BRAVE_API_KEY": "YOUR_API_KEY_HERE",
        "MCP_HTTP_PROXY": "https://example.com:10890" // Optional, remove if not needed
      }
    }
  }
}
```

This will automatically download and run the latest version of the tool when needed.

### Required Setup

1. Enable Accessibility for Claude:
   - Open System Settings
   - Go to Privacy & Security > Accessibility
   - Click the "+" button
   - Add Claude from your Applications folder
   - Turn ON the toggle for Claude

This accessibility setting is required for automated clipboard operations (Cmd+V) to work properly.

## For Developers

The following sections are for those who want to develop or modify the tool.

## Prerequisites

- Node.js 18+
- macOS (for clipboard operations)
- Claude Desktop (install from https://claude.ai/desktop)
- tsx (install via `npm install -g tsx`)

## Installation

### Installing via Smithery

To install MCP Fetch for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@kwp-lab/mcp-fetch):

```bash
npx -y @smithery/cli install @kwp-lab/mcp-fetch --client claude
```

### Manual Installation

```bash
git clone https://github.com/kwp-lab/mcp-fetch.git
cd mcp-fetch
npm install
npm run build
```

## Configuration

1. Make sure Claude Desktop is installed and running.

2. Install tsx globally if you haven't:

    ```bash
    npm install -g tsx
    # or
    pnpm add -g tsx
    ```

3. Modify your Claude Desktop config located at:

`~/Library/Application Support/Claude/claude_desktop_config.json`

You can easily find this through the Claude Desktop menu:

1. Open Claude Desktop
2. Click Claude on the Mac menu bar
3. Click "Settings"
4. Click "Developer"

Add the following to your MCP client's configuration:

```json
{
  "tools": {
    "fetch": {
      "args": ["tsx", "/path/to/mcp-fetch/index.ts"]
    }
  }
}
```
