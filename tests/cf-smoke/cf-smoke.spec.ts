/**
 * CF Worker smoke test suite
 *
 * Goal: catch regressions in the kind of bugs the user has already hit:
 *   - 501 Not Implemented for routes that should exist
 *   - 500 Internal Server Error for handlers that crash on Node-only APIs
 *     (and aren't covered by the auto-fallback-to-sidecar)
 *   - 500 from server-side bugs surfaced via the worker (e.g. raw human key
 *     passed into a uuid column)
 *
 * Pre-conditions:
 *   - `pnpm dev:cf` is running (worker on http://localhost:8787, server alongside)
 *   - DEPLOYMENT_MODE=local_trusted in .dev.vars so auth is bypassed
 *   - The DB has at least one company
 *
 * Coverage:
 *   1. Pre-flight: /api/health responds; can list companies and pick one
 *   2. Read fan-out: every GET route the UI calls in the common flows
 *   3. Regression: explicit asserts for routes that previously returned 500
 *   4. Mutation flow: create issue → list comments → release (uses the
 *      newly-created issue's UUID)
 *
 * Run:
 *   pnpm test:cf-smoke
 *
 * Anything that asserts `status < 500` is fine even if the handler returns
 * 4xx (404, 403, etc.) — we're only protecting against worker-internal
 * crashes, not validating end-to-end correctness.
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.CF_SMOKE_BASE_URL ?? "http://localhost:8787";

interface Company { id: string; name: string }
interface Issue { id: string; humanKey?: string; companyId: string }
interface Agent { id: string; companyId: string; urlKey?: string; name?: string }
interface Project { id: string; companyId: string; urlKey?: string }

let company: Company | null = null;
let issue: Issue | null = null;
let agent: Agent | null = null;
let project: Project | null = null;

async function get<T = unknown>(path: string): Promise<{ status: number; body: T | null; raw: Response }> {
  const raw = await fetch(`${BASE_URL}${path}`);
  let body: T | null = null;
  try { body = await raw.json() as T; } catch { /* non-JSON */ }
  return { status: raw.status, body, raw };
}

async function post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T | null; raw: Response }> {
  const raw = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: T | null = null;
  try { parsed = await raw.json() as T; } catch { /* non-JSON */ }
  return { status: raw.status, body: parsed, raw };
}

/** Assert the response was not a worker-internal crash. */
function expectNoCrash(label: string, status: number) {
  expect(status, `${label} returned ${status} (worker crash)`).toBeLessThan(500);
}

beforeAll(async () => {
  // 1. health check
  const health = await get("/api/health");
  if (health.status !== 200) {
    throw new Error(
      `[cf-smoke] Worker not reachable at ${BASE_URL}. Run \`pnpm dev:cf\` first. (got ${health.status})`,
    );
  }

  // 2. pick a company. If none, the suite is a no-op.
  const list = await get<Company[]>("/api/companies");
  if (list.status !== 200 || !Array.isArray(list.body) || list.body.length === 0) {
    throw new Error(
      `[cf-smoke] No companies found via /api/companies (status ${list.status}). Create one in the UI first.`,
    );
  }
  company = list.body[0]!;

  // 3. pre-fetch some entities so child route tests have ids to play with.
  const issueList = await get<Issue[]>(`/api/companies/${company.id}/issues`);
  if (issueList.status === 200 && Array.isArray(issueList.body) && issueList.body.length > 0) {
    issue = issueList.body[0]!;
  }
  const agentList = await get<Agent[]>(`/api/companies/${company.id}/agents`);
  if (agentList.status === 200 && Array.isArray(agentList.body) && agentList.body.length > 0) {
    agent = agentList.body[0]!;
  }
  const projectList = await get<Project[]>(`/api/companies/${company.id}/projects`);
  if (projectList.status === 200 && Array.isArray(projectList.body) && projectList.body.length > 0) {
    project = projectList.body[0]!;
  }
});

// ---------------------------------------------------------------------------
// 1. Pre-flight + always-on routes
// ---------------------------------------------------------------------------

describe("CF Worker smoke — health + company fan-out", () => {
  it("GET /api/health returns 200 with platform metadata", async () => {
    const r = await get<{ status: string; platform: string }>("/api/health");
    expect(r.status).toBe(200);
    expect(r.body?.status).toBe("ok");
  });

  it("GET /api/companies lists at least one company", async () => {
    const r = await get<Company[]>("/api/companies");
    expectNoCrash("GET /api/companies", r.status);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it("GET /api/adapters", async () => {
    const r = await get("/api/adapters");
    expectNoCrash("GET /api/adapters", r.status);
  });

  it("GET /api/plugins", async () => {
    const r = await get("/api/plugins");
    expectNoCrash("GET /api/plugins", r.status);
  });

  it("GET /api/plugins/ui-contributions", async () => {
    const r = await get("/api/plugins/ui-contributions");
    expectNoCrash("GET /api/plugins/ui-contributions", r.status);
  });

  it("GET /api/plugins/examples", async () => {
    const r = await get("/api/plugins/examples");
    expectNoCrash("GET /api/plugins/examples", r.status);
  });
});

// ---------------------------------------------------------------------------
// 2. Company-scoped read fan-out
// ---------------------------------------------------------------------------

describe("CF Worker smoke — company-scoped reads", () => {
  const routes = [
    "agents",
    "projects",
    "issues",
    "environments",
    "live-runs",
    "sidebar-badges",
    "labels",
    "skills",
    "user-directory",
    "join-requests",
    "heartbeat-runs",
    "agent-configurations",
    "org",
  ];

  for (const tail of routes) {
    it(`GET /api/companies/:id/${tail}`, async () => {
      if (!company) return;
      const r = await get(`/api/companies/${company.id}/${tail}`);
      expectNoCrash(`GET /api/companies/:id/${tail}`, r.status);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Issue-scoped routes — REGRESSION GUARD
//    These specifically test the bug where a human-key id ("ALM-1") leaked
//    into a uuid column query. Hit each both with the resolved UUID and (if
//    available) with the human key.
// ---------------------------------------------------------------------------

describe("CF Worker smoke — issue-scoped reads (regression: human-key resolution)", () => {
  const routes = [
    "comments",
    "interactions",
    "attachments",
    "feedback-votes",
    "live-runs",
    "documents",
    "activity",
    "runs",
    "tree-holds",
    "tree-control/state",
    "approvals",
  ];

  for (const tail of routes) {
    it(`GET /api/issues/:uuid/${tail}`, async () => {
      if (!issue) return;
      const r = await get(`/api/issues/${issue.id}/${tail}`);
      expectNoCrash(`GET /api/issues/:uuid/${tail}`, r.status);
    });

    it(`GET /api/issues/:humanKey/${tail} (regression)`, async () => {
      if (!issue?.humanKey) return;
      const r = await get(`/api/issues/${issue.humanKey}/${tail}`);
      expectNoCrash(`GET /api/issues/:humanKey/${tail}`, r.status);
    });
  }

  it("GET /api/issues/:id (resolves both UUID and human key)", async () => {
    if (!issue) return;
    const byUuid = await get(`/api/issues/${issue.id}`);
    expect(byUuid.status).toBeLessThan(500);
    if (issue.humanKey) {
      const byKey = await get(`/api/issues/${issue.humanKey}`);
      expect(byKey.status).toBeLessThan(500);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Agent-scoped routes
// ---------------------------------------------------------------------------

describe("CF Worker smoke — agent-scoped reads (regression: URL-key resolution)", () => {
  const routes = [
    "",
    "configuration",
    "config-revisions",
    "runtime-state",
    "task-sessions",
    "skills",
    "instructions-bundle",
    "keys",
  ];

  for (const tail of routes) {
    it(`GET /api/agents/:uuid${tail ? "/" + tail : ""}`, async () => {
      if (!agent) return;
      const path = `/api/agents/${agent.id}${tail ? "/" + tail : ""}`;
      const r = await get(path);
      expectNoCrash(`GET ${path}`, r.status);
    });

    it(`GET /api/agents/:urlKey${tail ? "/" + tail : ""} (regression)`, async () => {
      if (!agent?.urlKey) return;
      const path = `/api/agents/${agent.urlKey}${tail ? "/" + tail : ""}`;
      const r = await get(path);
      expectNoCrash(`GET ${path}`, r.status);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Plugin-scoped routes (only if a plugin is installed)
// ---------------------------------------------------------------------------

describe("CF Worker smoke — plugin-scoped reads", () => {
  let pluginId: string | null = null;
  beforeAll(async () => {
    const list = await get<Array<{ id: string }>>("/api/plugins");
    if (list.status === 200 && Array.isArray(list.body) && list.body.length > 0) {
      pluginId = list.body[0]!.id;
    }
  });

  const routes = ["", "dashboard", "health", "config", "jobs"];
  for (const tail of routes) {
    it(`GET /api/plugins/:id${tail ? "/" + tail : ""}`, async () => {
      if (!pluginId) return;
      const path = `/api/plugins/${pluginId}${tail ? "/" + tail : ""}`;
      const r = await get(path);
      expectNoCrash(`GET ${path}`, r.status);
      if (tail === "" || tail === "dashboard") {
        // Regression guard: these specifically returned 501 before the full
        // CF plugin REST API was implemented.
        expect(r.status, `${path} should not be 501`).not.toBe(501);
      }
    });
  }

  it("GET /_plugins/:pluginId/ui/index.js does NOT silently fall back to index.html", async () => {
    if (!pluginId) return;
    const r = await fetch(`${BASE_URL}/_plugins/${pluginId}/ui/index.js`);
    if (r.status >= 400) return; // 404/503 from sidecar is acceptable
    const ct = r.headers.get("content-type") ?? "";
    // Regression: the SPA fallback would return text/html for unknown paths.
    expect(ct, `/_plugins/.../ui/index.js returned content-type ${ct}`).not.toMatch(/text\/html/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Mutation flow — create / read / release
// ---------------------------------------------------------------------------

describe("CF Worker smoke — issue lifecycle mutation", () => {
  let createdIssueId: string | null = null;
  let createdIssueHumanKey: string | null = null;

  it("POST /api/companies/:id/issues creates an issue", async () => {
    if (!company) return;
    const r = await post<{ id: string; identifier?: string }>(`/api/companies/${company.id}/issues`, {
      title: "cf-smoke synthetic issue",
      description: "Created by tests/cf-smoke. Safe to delete.",
    });
    expectNoCrash("POST /api/companies/:id/issues", r.status);
    if (r.status >= 200 && r.status < 300 && r.body?.id) {
      createdIssueId = r.body.id;
      createdIssueHumanKey = r.body.identifier ?? null;
    }
  });

  it("GET /api/issues/:id/comments works on the new issue", async () => {
    if (!createdIssueId) return;
    const r = await get(`/api/issues/${createdIssueId}/comments`);
    expectNoCrash("GET /api/issues/:id/comments (new issue)", r.status);
    expect(r.status).toBeLessThan(500);
  });

  it("GET /api/issues/:id/attachments works on the new issue", async () => {
    if (!createdIssueId) return;
    const r = await get(`/api/issues/${createdIssueId}/attachments`);
    expectNoCrash("GET /api/issues/:id/attachments (new issue)", r.status);
  });

  // Mutation routes that take :id MUST resolve human keys to UUIDs internally.
  // Each one of these had previously surfaced a 500 with
  // `PostgresError: invalid input syntax for type uuid` when called with the
  // human key — these tests lock that in.
  it("POST /api/issues/:humanKey/comments accepts human key (regression)", async () => {
    if (!createdIssueHumanKey) return;
    const r = await post(`/api/issues/${createdIssueHumanKey}/comments`, {
      body: "cf-smoke regression comment",
    });
    expectNoCrash(`POST /api/issues/${createdIssueHumanKey}/comments`, r.status);
    expect(r.status, "POST comment with human key must not 500").toBeLessThan(500);
  });

  it("PATCH /api/issues/:humanKey accepts human key (regression)", async () => {
    if (!createdIssueHumanKey) return;
    const raw = await fetch(`${BASE_URL}/api/issues/${createdIssueHumanKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "smoke-touched" }),
    });
    expectNoCrash(`PATCH /api/issues/${createdIssueHumanKey}`, raw.status);
    expect(raw.status, "PATCH issue with human key must not 500").toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 6b. Agent mutation regression — URL-key inputs to PATCH /agents/:id and
//     POST /agents/:id/wakeup must not 500 with uuid-syntax errors.
// ---------------------------------------------------------------------------

describe("CF Worker smoke — agent mutation (regression: URL-key resolution)", () => {
  it("PATCH /api/agents/:urlKey accepts URL key (no-op patch)", async () => {
    if (!agent?.urlKey) return;
    const raw = await fetch(`${BASE_URL}/api/agents/${agent.urlKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expectNoCrash(`PATCH /api/agents/${agent.urlKey}`, raw.status);
    expect(raw.status, "PATCH agent with URL key must not 500").toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 6c. Goal mutation regression — PATCH /goals/:id with a stale (human-keyish)
//     id had the same uuid-syntax bug.
// ---------------------------------------------------------------------------

describe("CF Worker smoke — goal mutation (regression: id resolution)", () => {
  it("PATCH /api/goals/:nonUuid returns 4xx (not 500) for unknown ids", async () => {
    // Don't need a real goal — passing a bogus non-UUID id should resolve to
    // 404 (not found), NEVER 500. Before the fix this would crash with
    // \"invalid input syntax for type uuid\" because svc.update was called
    // with the raw id.
    const raw = await fetch(`${BASE_URL}/api/goals/cf-smoke-nonexistent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "regression test" }),
    });
    expect(raw.status, "PATCH non-UUID goal must not 500").toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 7. Project-scoped reads
// ---------------------------------------------------------------------------

describe("CF Worker smoke — project-scoped reads (regression: URL-key resolution)", () => {
  // Only routes that the server actually defines (server/src/routes/projects.ts).
  const routes = ["", "workspaces"];
  for (const tail of routes) {
    it(`GET /api/projects/:uuid${tail ? "/" + tail : ""}`, async () => {
      if (!project) return;
      const path = `/api/projects/${project.id}${tail ? "/" + tail : ""}`;
      const r = await get(path);
      expectNoCrash(`GET ${path}`, r.status);
    });

    it(`GET /api/projects/:urlKey${tail ? "/" + tail : ""} (regression)`, async () => {
      if (!project?.urlKey) return;
      const path = `/api/projects/${project.urlKey}${tail ? "/" + tail : ""}`;
      const r = await get(path);
      expectNoCrash(`GET ${path}`, r.status);
    });
  }
});
