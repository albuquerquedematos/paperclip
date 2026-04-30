/**
 * CfAgentInstructionsService — Cloudflare Workers implementation of the agent
 * instructions storage layer.
 *
 * Background (from agent-instructions.ts):
 *   The Node server manages a per-agent directory tree of Markdown instruction
 *   files entirely through node:fs/promises: readdir + stat for listing,
 *   readFile for retrieval, writeFile + mkdir for creation/update, and rm for
 *   deletion. The tree root is resolved via resolveHomeAwarePath /
 *   resolvePaperclipInstanceRoot and honours a "managed bundle mode" that
 *   controls where the entry file lives (AGENTS.md by default).
 *
 *   Key types from that module:
 *     BundleMode              — "managed" | "external"
 *     AgentInstructionsBundle — { agentId, companyId, mode, entryFile, files, … }
 *     AgentInstructionsFileSummary — { path, size, language, isEntryFile, … }
 *     AgentInstructionsFileDetail  — extends summary with { content }
 *
 * Workers replacement strategy:
 *   - All files live in R2 under `instructions/{companyId}/{agentId}/{filename}`.
 *   - Directory listing is replaced by R2 prefix listing (list.objects).
 *   - mkdir / rm / writeFile → r2.put / r2.delete.
 *   - The entry file defaults to "AGENT.md" (aligned with the server's
 *     ENTRY_FILE_DEFAULT = "AGENTS.md"; callers may override).
 *   - Ignored filenames (.DS_Store, Thumbs.db, Desktop.ini) from the Node
 *     implementation are filtered out in listInstructionFiles.
 *   - External-mode bundles (pointing to a host path) are not supported in a
 *     stateless Worker and must be handled by the sidecar.
 *
 * All code here is Web-API-only — no Node imports.
 */

// ---------------------------------------------------------------------------
// Constants mirrored from agent-instructions.ts
// ---------------------------------------------------------------------------

const DEFAULT_ENTRY_FILE = "AGENT.md";

/** Files that should never be surfaced, matching IGNORED_INSTRUCTIONS_FILE_NAMES. */
const IGNORED_FILENAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);

// ---------------------------------------------------------------------------
// R2 key helpers
// ---------------------------------------------------------------------------

function instructionsPrefix(companyId: string, agentId: string): string {
  return `instructions/${companyId}/${agentId}/`;
}

function instructionsKey(companyId: string, agentId: string, filename: string): string {
  return `${instructionsPrefix(companyId, agentId)}${filename}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CfAgentInstructionsService {
  constructor(private r2: R2Bucket) {}

  // -------------------------------------------------------------------------
  // Read — mirrors readFile(resolvedEntryPath) in agent-instructions.ts
  // -------------------------------------------------------------------------

  async getInstructions(
    agentId: string,
    companyId: string,
    filename = DEFAULT_ENTRY_FILE,
  ): Promise<string | null> {
    const result = await this.r2.get(instructionsKey(companyId, agentId, filename));
    return result ? result.text() : null;
  }

  // -------------------------------------------------------------------------
  // Write — mirrors writeFile(resolvedEntryPath) + mkdir(dir) in agent-instructions.ts
  // -------------------------------------------------------------------------

  async putInstructions(
    agentId: string,
    companyId: string,
    content: string,
    filename = DEFAULT_ENTRY_FILE,
  ): Promise<void> {
    await this.r2.put(instructionsKey(companyId, agentId, filename), content, {
      httpMetadata: { contentType: "text/markdown" },
    });
  }

  // -------------------------------------------------------------------------
  // List — mirrors readdir + stat loop in agent-instructions.ts
  //
  // Returns relative filenames (no prefix), filtered to remove OS noise files.
  // -------------------------------------------------------------------------

  async listInstructionFiles(agentId: string, companyId: string): Promise<string[]> {
    const prefix = instructionsPrefix(companyId, agentId);
    const list = await this.r2.list({ prefix });

    return list.objects
      .map((obj) => obj.key.replace(prefix, ""))
      .filter((name) => !IGNORED_FILENAMES.has(name));
  }

  // -------------------------------------------------------------------------
  // Delete — mirrors rm(managedRootPath, { recursive: true }) in agent-instructions.ts
  // -------------------------------------------------------------------------

  async deleteInstructions(agentId: string, companyId: string): Promise<void> {
    const prefix = instructionsPrefix(companyId, agentId);
    const list = await this.r2.list({ prefix });

    for (const obj of list.objects) {
      await this.r2.delete(obj.key);
    }
  }

  // -------------------------------------------------------------------------
  // Check existence — equivalent to stat(resolvedEntryPath) guard used before reads
  // -------------------------------------------------------------------------

  async hasInstructions(
    agentId: string,
    companyId: string,
    filename = DEFAULT_ENTRY_FILE,
  ): Promise<boolean> {
    const result = await this.r2.head(instructionsKey(companyId, agentId, filename));
    return result !== null;
  }
}
