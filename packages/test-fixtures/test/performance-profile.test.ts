import { describe, expect, it } from "vitest";

import {
  type FixtureInventory,
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
  M4_PERFORMANCE_PROFILE_HASH,
  M4_PERFORMANCE_PROFILE_VERSION,
  m4PerformanceProfile,
  sha256FixtureSource,
} from "../src/index.js";

const EXPECTED_PROFILE_HASH = "907df17483db1d654ea8a128ca10e0a82ab227c5153440e4a68c7cd7433e8641";

describe("versioned M4 performance acceptance profile", () => {
  it("pins the browser environment, sample counts, and non-negotiable thresholds", () => {
    expect(M4_PERFORMANCE_PROFILE_VERSION).toBe(1);
    expect(M4_PERFORMANCE_PROFILE_HASH).toBe(EXPECTED_PROFILE_HASH);
    expect(structuredClone(m4PerformanceProfile)).toEqual(m4PerformanceProfile);
    expect(m4PerformanceProfile.environment).toMatchObject({
      browser: "CURRENT_STABLE_CHROME",
      headless: true,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      playwrightWorkers: 1,
      retries: 0,
      percentile: "NEAREST_RANK_P95",
    });
    expect(m4PerformanceProfile.parse).toEqual({
      warmupSamples: 3,
      measuredSamples: 20,
      p95ThresholdMs: 1_000,
    });
    expect(m4PerformanceProfile.coldInteractive).toEqual({
      isolatedContextSamples: 20,
      p95ThresholdMs: 3_000,
    });
    expect(m4PerformanceProfile.viewSwitch).toMatchObject({
      sourceViewCount: 7,
      samplesPerSourceView: 3,
      observationThresholdMs: 300,
      p95ThresholdMs: 300,
    });
    expect(m4PerformanceProfile.frameRate).toMatchObject({
      tableCount: 200,
      referenceCount: 1_000,
      durationMs: 2_000,
      runsPerInteraction: 5,
      p95FrameIntervalThresholdMs: 33.34,
      medianFrameIntervalTargetMs: 16.67,
    });
    expect(m4PerformanceProfile.sourceInput).toEqual({
      inputEventsPerRun: 30,
      runs: 5,
      longTaskThresholdMs: 100,
      allowedLongTasks: 0,
    });
  });

  it("binds the profile to deterministic source bytes, hashes, and inventories", () => {
    const fidelity = generateFidelityFixture();
    const scale = generateScaleFixture();

    expect(evidence(fidelity, fixtureInventory.fidelity)).toEqual(
      m4PerformanceProfile.fixtures.fidelity,
    );
    expect(evidence(scale, fixtureInventory.scale)).toEqual(m4PerformanceProfile.fixtures.scale);
  });
});

function evidence(source: string, inventory: FixtureInventory) {
  return {
    sourceHash: sha256FixtureSource(source),
    utf8Bytes: Buffer.byteLength(source, "utf8"),
    inventory,
  };
}
