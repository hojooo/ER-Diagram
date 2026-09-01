import { createHash } from "node:crypto";

import type { FixtureInventory } from "./synthetic-fixtures.js";

export const M4_PERFORMANCE_PROFILE_VERSION = 1 as const;

export interface PerformanceFixtureEvidence {
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly inventory: FixtureInventory;
}

export interface M4PerformanceProfile {
  readonly profileVersion: 1;
  readonly environment: {
    readonly browser: "CURRENT_STABLE_CHROME";
    readonly headless: true;
    readonly viewport: { readonly width: 1440; readonly height: 900 };
    readonly deviceScaleFactor: 1;
    readonly playwrightWorkers: 1;
    readonly retries: 0;
    readonly minimumLogicalCpu: 4;
    readonly minimumMemoryBytes: number;
    readonly percentile: "NEAREST_RANK_P95";
  };
  readonly fixtures: {
    readonly fidelity: PerformanceFixtureEvidence;
    readonly scale: PerformanceFixtureEvidence;
  };
  readonly parse: {
    readonly warmupSamples: 3;
    readonly measuredSamples: 20;
    readonly p95ThresholdMs: 1_000;
  };
  readonly coldInteractive: {
    readonly isolatedContextSamples: 20;
    readonly p95ThresholdMs: 3_000;
  };
  readonly viewSwitch: {
    readonly sourceViewCount: 7;
    readonly samplesPerSourceView: 3;
    readonly orderedCycles: 1;
    readonly observationThresholdMs: 300;
    readonly p95ThresholdMs: 300;
  };
  readonly frameRate: {
    readonly tableCount: 200;
    readonly referenceCount: 1_000;
    readonly interactions: readonly ["DRAG", "PAN", "ZOOM"];
    readonly durationMs: 2_000;
    readonly runsPerInteraction: 5;
    readonly p95FrameIntervalThresholdMs: 33.34;
    readonly medianFrameIntervalTargetMs: 16.67;
  };
  readonly sourceInput: {
    readonly inputEventsPerRun: 30;
    readonly runs: 5;
    readonly longTaskThresholdMs: 100;
    readonly allowedLongTasks: 0;
  };
}

export const m4PerformanceProfile = {
  profileVersion: M4_PERFORMANCE_PROFILE_VERSION,
  environment: {
    browser: "CURRENT_STABLE_CHROME",
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    playwrightWorkers: 1,
    retries: 0,
    minimumLogicalCpu: 4,
    minimumMemoryBytes: 8 * 1024 * 1024 * 1024,
    percentile: "NEAREST_RANK_P95",
  },
  fixtures: {
    fidelity: {
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
    scale: {
      sourceHash: "2a14b1c7444020815b949166d9b15059371294dcd95d066848700b523a93a434",
      utf8Bytes: 118_982,
      inventory: {
        tables: 200,
        enums: 0,
        tablePartials: 0,
        tableGroups: 0,
        diagramViews: 0,
        references: 1_000,
      },
    },
  },
  parse: {
    warmupSamples: 3,
    measuredSamples: 20,
    p95ThresholdMs: 1_000,
  },
  coldInteractive: {
    isolatedContextSamples: 20,
    p95ThresholdMs: 3_000,
  },
  viewSwitch: {
    sourceViewCount: 7,
    samplesPerSourceView: 3,
    orderedCycles: 1,
    observationThresholdMs: 300,
    p95ThresholdMs: 300,
  },
  frameRate: {
    tableCount: 200,
    referenceCount: 1_000,
    interactions: ["DRAG", "PAN", "ZOOM"],
    durationMs: 2_000,
    runsPerInteraction: 5,
    p95FrameIntervalThresholdMs: 33.34,
    medianFrameIntervalTargetMs: 16.67,
  },
  sourceInput: {
    inputEventsPerRun: 30,
    runs: 5,
    longTaskThresholdMs: 100,
    allowedLongTasks: 0,
  },
} as const satisfies M4PerformanceProfile;

export const M4_PERFORMANCE_PROFILE_HASH = createHash("sha256")
  .update(JSON.stringify(m4PerformanceProfile), "utf8")
  .digest("hex");
