import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Wraps a handler body so backend/guard errors become a well-formed
 * CallToolResult with isError: true instead of an uncaught rejection -
 * keeps the "fail closed, but tell the caller why" behavior consistent
 * across every tool.
 */
export async function withToolErrorHandling(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown tool error.";
    return errorResult(message);
  }
}
