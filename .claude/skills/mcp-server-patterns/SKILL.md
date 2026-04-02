---
name: mcp-server-patterns
description: Canonical MCP server patterns for Node/TypeScript — tools, resources, prompts, Zod validation, stdio vs Streamable HTTP transport. Reference before adding MCP tools to gif.
origin: ECC
---

# MCP Server Patterns

Canonical patterns for building MCP servers with the Node.js/TypeScript SDK.

## Tool Definition Pattern

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "gif", version: "1.0.0" });

server.tool(
  "tool-name",
  "Clear description of what this tool does and when to use it",
  {
    // Zod schema — all inputs validated before handler runs
    param1: z.string().describe("What this parameter is for"),
    param2: z.number().optional().describe("Optional numeric parameter"),
  },
  async ({ param1, param2 }) => {
    // Handler receives validated, typed inputs
    const result = await doWork(param1, param2);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

## Transport: stdio vs Streamable HTTP

```typescript
// stdio — for local MCP servers (gif's primary transport)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const transport = new StdioServerTransport();
await server.connect(transport);

// Streamable HTTP — for remote/multi-client deployments
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
```

## Resource Definition Pattern

```typescript
server.resource(
  "resource-name",
  "resource://scheme/path/{id}",
  { description: "What this resource provides" },
  async (uri, { id }) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
  })
);
```

## Error Handling

```typescript
// Return structured errors — don't throw from tool handlers
async ({ param }) => {
  try {
    const result = await doWork(param);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
```

## Zod Validation Patterns

```typescript
// Enum input
status: z.enum(["active", "inactive", "pending"]).describe("Entity status"),

// Array input
ids: z.array(z.string().uuid()).min(1).max(100).describe("Entity IDs to fetch"),

// Optional with default
limit: z.number().int().min(1).max(1000).default(50).describe("Max results"),

// Union type
filter: z.union([z.string(), z.object({ field: z.string(), value: z.unknown() })]),
```

## Tool Description Quality

Tool descriptions are the primary way Claude decides which tool to use. Make them:
- State the exact action performed
- List what it returns
- Note when to use it vs. similar tools
- Include parameter constraints in the Zod schema, not the description

## Testing MCP Tools

```typescript
// Test the handler logic directly — don't test the MCP protocol
describe("tool-name handler", () => {
  it("returns expected shape for valid input", async () => {
    const result = await handler({ param1: "test", param2: 42 });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toMatchObject({ expected: "shape" });
  });

  it("returns isError: true on failure", async () => {
    const result = await handler({ param1: "will-fail" });
    expect(result.isError).toBe(true);
  });
});
```

## gif-Specific Conventions

- All DB queries go through the repository layer, not directly in tool handlers
- Tool handlers are thin: validate → call service → format response
- Use `tsc --noEmit` to verify types before testing
- Tool names use kebab-case matching the domain concept (`get-entity`, `search-programs`)
