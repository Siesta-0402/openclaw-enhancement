/**
 * partitionToolCalls - Concurrent-safe tool call partitioning
 * ============================================================
 *
 * Analyzes tool calls and partitions them into parallel-safe and
 * serial-safe groups based on their mutation characteristics.
 *
 * Read-only tools: read, glob, grep, web-fetch, web-search (can run in parallel)
 * Write/mutate tools: write, edit, exec, bash (must run serially)
 */

// Local ToolCall type - only name and id properties are used in this module
type ToolCall = { name: string; id?: string; };


/** Tool categories for concurrency analysis */
export type ToolConcurrencyCategory = "read-only" | "write" | "unknown";

/**
 * Partition result for tool calls
 */
export interface ToolCallPartition {
  /** Tool calls that can run in parallel (read-only) */
  parallel: ToolCall[];
  /** Tool calls that must run serially (writes/mutations) */
  serial: ToolCall[];
  /** Partition metadata */
  metadata: {
    totalCount: number;
    parallelCount: number;
    serialCount: number;
    unknownCount: number;
  };
}

/**
 * Tools classified as read-only (safe for parallel execution)
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "web-fetch",
  "web_search",
  "web-search",
  "Image",
  "image",
  "Transcribe",
  "transcribe",
  "Summarize",
  "summarize",
  "Think",
  "think",
  "html_to_markdown",
  "html-to-markdown",
  "document_to_markdown",
  "document-to-markdown",
  "visit",
  "Visit",
]);

/**
 * Tools classified as write/mutate (must run serially)
 */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "exec",
  "bash",
  "shell",
  "npm",
  "install",
  "uninstall",
  "mkdir",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "touch",
  "chmod",
  "chown",
]);

/**
 * Tools that have unknown/default concurrency behavior
 */
const UNKNOWN_TOOLS = new Set([
  "Task",
  "task",
  "Subagent",
  "subagent",
  "Message",
  "message",
  "SessionsSend",
  "sessions-send",
  "SessionsList",
  "sessions-list",
  "SessionsHistory",
  "sessions-history",
]);

/**
 * Determine if a tool is concurrency-safe (read-only).
 */
export function isConcurrencySafe(toolName: string): boolean {
  const lowerName = toolName.toLowerCase();
  return READ_ONLY_TOOLS.has(lowerName);
}

/**
 * Determine if a tool performs writes/mutations.
 */
export function isWriteTool(toolName: string): boolean {
  const lowerName = toolName.toLowerCase();
  return WRITE_TOOLS.has(lowerName);
}

/**
 * Get the concurrency category for a tool.
 */
export function getToolConcurrencyCategory(toolName: string): ToolConcurrencyCategory {
  const lowerName = toolName.toLowerCase();
  if (READ_ONLY_TOOLS.has(lowerName)) {
    return "read-only";
  }
  if (WRITE_TOOLS.has(lowerName)) {
    return "write";
  }
  return "unknown";
}

/**
 * Partition an array of tool calls into parallel and serial groups.
 *
 * @param toolCalls - Array of tool calls to partition
 * @returns Partitioned result with parallel, serial groups and metadata
 */
export function partitionToolCalls(toolCalls: ToolCall[]): ToolCallPartition {
  const parallel: ToolCall[] = [];
  const serial: ToolCall[] = [];
  let unknownCount = 0;

  for (const toolCall of toolCalls) {
    const category = getToolConcurrencyCategory(toolCall.name);

    switch (category) {
      case "read-only":
        parallel.push(toolCall);
        break;
      case "write":
        serial.push(toolCall);
        break;
      case "unknown":
      default:
        // Unknown tools go to serial for safety
        serial.push(toolCall);
        unknownCount++;
        break;
    }
  }

  return {
    parallel,
    serial,
    metadata: {
      totalCount: toolCalls.length,
      parallelCount: parallel.length,
      serialCount: serial.length,
      unknownCount,
    },
  };
}

/**
 * Execute tool calls with proper concurrency handling.
 *
 * Read-only tools run in parallel, write tools run serially.
 * Write tools block until all parallel tools complete.
 *
 * @param toolCalls - Tool calls to execute
 * @param executor - Function to execute a single tool call
 * @returns Array of results in same order as input
 */
export async function executePartitionedToolCalls<T>(
  toolCalls: ToolCall[],
  executor: (toolCall: ToolCall) => Promise<T>
): Promise<T[]> {
  const partition = partitionToolCalls(toolCalls);

  // If no calls, return empty
  if (toolCalls.length === 0) {
    return [];
  }

  // If all parallel, run them all in parallel
  if (partition.serial.length === 0) {
    return Promise.all(toolCalls.map(executor));
  }

  // If all serial, run them all serially
  if (partition.parallel.length === 0) {
    const results: T[] = [];
    for (const toolCall of toolCalls) {
      results.push(await executor(toolCall));
    }
    return results;
  }

  // Mixed: run parallel first, then serial
  // Wait for all parallel to complete
  const parallelResults = await Promise.all(
    partition.parallel.map(async (toolCall) => {
      const result = await executor(toolCall);
      return { toolCall, result };
    })
  );

  // Build result map
  const resultMap = new Map<string, T>();
  for (const { toolCall, result } of parallelResults) {
    resultMap.set(toolCall.id, result);
  }

  // Run serial tools and add to map
  for (const toolCall of partition.serial) {
    const result = await executor(toolCall);
    resultMap.set(toolCall.id, result);
  }

  // Return results in original order
  return toolCalls.map((tc) => resultMap.get(tc.id)!);
}

/**
 * Check if a tool call sequence has potential conflicts.
 * Returns warnings for potentially unsafe patterns.
 */
export function analyzeToolCallSafety(
  toolCalls: ToolCall[]
): { warnings: string[]; isSafe: boolean } {
  const warnings: string[] = [];
  const partition = partitionToolCalls(toolCalls);

  // Check for many serial tools
  if (partition.serial.length > 5) {
    warnings.push(
      `Many serial tools (${partition.serial.length}) may cause slow execution`
    );
  }

  // Check for unknown tools
  if (partition.metadata.unknownCount > 0) {
    warnings.push(
      `${partition.metadata.unknownCount} tool(s) have unknown concurrency behavior, treating as serial`
    );
  }

  // Check for mixed read and write in same batch
  if (partition.parallel.length > 0 && partition.serial.length > 0) {
    warnings.push(
      `Mixed read-only (${partition.parallel.length}) and write (${partition.serial.length}) tools detected`
    );
  }

  return {
    warnings,
    isSafe: warnings.length === 0,
  };
}
