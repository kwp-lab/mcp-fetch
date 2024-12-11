# MCP Fetch

Model Context Protocol server for fetching web content and processing images. This allows Claude Desktop (or any MCP client) to fetch web content and handle images appropriately.

## Prerequisites

- Node.js 18+
- macOS (for clipboard operations)
- ImageMagick (for image processing)
- Claude Desktop (install from https://claude.ai/desktop)
- tsx (install via `npm install -g tsx`)

## Installation

```bash
git clone https://github.com/kazuph/mcp-fetch.git
cd mcp-fetch
npm install
npm run build
```

## Image Processing Specifications

When processing images from web content, the following limits are applied:

- Maximum 6 images per group
- Maximum height of 8000 pixels per group
- Maximum size of 30MB per group

If content exceeds these limits, images will be automatically split into multiple groups, and you'll need to paste (Cmd+V) multiple times.

## Configuration

1. Make sure Claude Desktop is installed and running.

2. Install ImageMagick if you haven't:
```bash
brew install imagemagick
```

3. Install tsx globally if you haven't:
```bash
npm install -g tsx
# or
pnpm add -g tsx
```

4. Modify your Claude Desktop config located at:
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

## Available Tools

- `fetch`: Retrieves URLs from the Internet and extracts their content as markdown. Images are automatically processed and prepared for clipboard operations.

## Notes

- This tool is designed for macOS only due to its dependency on macOS-specific clipboard operations.
- Images are processed using ImageMagick to ensure optimal size and layout.
- When multiple images are found, they are merged vertically with consideration for size limits.
