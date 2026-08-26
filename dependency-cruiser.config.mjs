/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular-dependencies",
      comment: "Top-level modules must remain acyclic.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "fastify-only-in-server-adapter",
      comment: "Move HTTP adapter code to apps/server.",
      severity: "error",
      from: { pathNot: "^apps/server/" },
      to: { path: "(^|/)node_modules/fastify/|^fastify$" },
    },
    {
      name: "framework-free-core-and-source-transform",
      comment: "Core and source-transform cannot depend on UI, HTTP, or persistence frameworks.",
      severity: "error",
      from: { path: "^packages/(core|source-transform)/" },
      to: {
        path: "(^|/)node_modules/(react|react-dom|@xyflow/react|fastify|better-sqlite3|drizzle-orm)/|^(react|react-dom|@xyflow/react|fastify|better-sqlite3|drizzle-orm)(/|$)",
      },
    },
    {
      name: "web-must-not-import-storage-sqlite",
      comment: "The web app talks to application contracts, not the SQLite adapter.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/storage-sqlite/|^@er-diagram/storage-sqlite(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|coverage|test-results|playwright-report|tests/architecture-fixtures)(/|$)",
  },
};
