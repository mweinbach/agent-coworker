#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({
  name: "test-echo-server",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    description: "Echoes input text back to the caller.",
    inputSchema: {
      text: z.string(),
    },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `echo:${text}`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
