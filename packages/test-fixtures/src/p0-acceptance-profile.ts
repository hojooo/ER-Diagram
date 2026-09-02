import { createHash } from "node:crypto";

import type { FixtureInventory } from "./synthetic-fixtures.js";

export const P0_ACCEPTANCE_PROFILE_VERSION = 1 as const;

export type P0ReleaseGateId = "A" | "B" | "C" | "D" | "E" | "F";

export interface P0AcceptanceReleaseGate {
  readonly gate: P0ReleaseGateId;
  readonly commands: readonly string[];
}

export interface P0AcceptanceProfile {
  readonly profileVersion: 1;
  readonly releaseState: "READY_FOR_P0_RELEASE";
  readonly fixture: {
    readonly dialect: "POSTGRESQL";
    readonly sourceHash: string;
    readonly utf8Bytes: number;
    readonly inventory: FixtureInventory;
  };
  readonly journey: {
    readonly projectName: string;
    readonly groupNames: readonly string[];
    readonly viewNames: readonly string[];
    readonly visualTarget: {
      readonly tableName: string;
      readonly tableKey: string;
      readonly columnName: string;
      readonly columnType: string;
    };
    readonly invalidSuffix: string;
    readonly sourceEditSuffix: string;
    readonly preservationSentinels: readonly string[];
    readonly assertions: readonly string[];
  };
  readonly releaseGates: readonly P0AcceptanceReleaseGate[];
}

const groupNames = Array.from(
  { length: 15 },
  (_, index) => `public.domain_${index.toString().padStart(2, "0")}`,
);

const viewNames = [
  "full_schema",
  "focus_01",
  "focus_02",
  "focus_03",
  "focus_04",
  "focus_05",
  "focus_06",
] as const;

const assertions = [
  "BUNDLE_NEW_PROJECT_ID",
  "BUNDLE_SOURCE_HISTORY_LAYOUT",
  "BUNDLE_VOLUME_B_RESTART",
  "DIAGRAM_GROUPS_AND_VIEWS",
  "DIAGRAM_LAYOUT_SOURCE_HASH_UNCHANGED",
  "HISTORY_INVALID_RESTORE",
  "HISTORY_RELOAD_IS_DURABLE",
  "HISTORY_UNDO_REDO",
  "OFFLINE_NO_REMOTE_REQUESTS",
  "RUNTIME_RELEASE_AND_SECURITY",
  "SOURCE_INVALID_LAST_VALID_RECOVERY",
  "SQL_EXPORT_REPARSE_AND_REPORT",
  "VISUAL_TARGET_ONLY_SOURCE_PATCH",
] as const;

export const p0AcceptanceProfile = {
  profileVersion: P0_ACCEPTANCE_PROFILE_VERSION,
  releaseState: "READY_FOR_P0_RELEASE",
  fixture: {
    dialect: "POSTGRESQL",
    sourceHash: "f43bccdd83369eb9fa606e4251ede3b747e117eb6c5648c9ca22d071affe5716",
    utf8Bytes: 147_689,
    inventory: {
      tables: 143,
      enums: 86,
      tablePartials: 4,
      tableGroups: 15,
      diagramViews: 7,
      references: 573,
    },
  },
  journey: {
    projectName: "P0 complete acceptance",
    groupNames,
    viewNames,
    visualTarget: {
      tableName: "core.entity_142",
      tableKey: 'table:["core","entity_142"]',
      columnName: "p0_acceptance_marker",
      columnType: "varchar",
    },
    invalidSuffix: "\nTable p0_gate_broken {",
    sourceEditSuffix: "\n// p0-source-edit-sentinel\n",
    preservationSentinels: [
      "Deterministic public synthetic fixture",
      "TablePartial audit_fields",
      "Note synthetic_overview",
      "DiagramView full_schema",
    ],
    assertions,
  },
  releaseGates: [
    { gate: "A", commands: ["pnpm ci:verify", "pnpm test:m1-gate"] },
    { gate: "B", commands: ["pnpm test:m3-gate", "pnpm test:p0-gate"] },
    { gate: "C", commands: ["pnpm test:m2-gate", "pnpm test:p0-gate"] },
    {
      gate: "D",
      commands: ["pnpm test:accessibility", "pnpm test:perf", "pnpm test:p0-gate"],
    },
    {
      gate: "E",
      commands: ["pnpm test:container", "pnpm test:p0-gate", "pnpm test:runtime-lifecycle"],
    },
    {
      gate: "F",
      commands: ["pnpm licenses:check", "pnpm sbom:check", "pnpm test:release"],
    },
  ],
} as const satisfies P0AcceptanceProfile;

export const P0_ACCEPTANCE_PROFILE_HASH = createHash("sha256")
  .update(JSON.stringify(p0AcceptanceProfile), "utf8")
  .digest("hex");
