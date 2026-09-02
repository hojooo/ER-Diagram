// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { DEFAULT_RUNTIME_CONFIG_RESPONSE, type RuntimeConfigResponse } from "@er-diagram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeReleaseDetails } from "../src/projects/project-home-page.js";
import { RuntimeConfigProvider } from "../src/runtime-config.js";

afterEach(cleanup);

describe("runtime release identity", () => {
  it("shows source-free development evidence", () => {
    renderRelease(DEFAULT_RUNTIME_CONFIG_RESPONSE);

    expect(screen.getByRole("heading", { name: "Runtime release" })).toBeInTheDocument();
    expect(screen.getByText("Development build")).toBeInTheDocument();
    expect(metadata("Image version")).toHaveTextContent("development");
    expect(metadata("Source revision")).toHaveTextContent("Not embedded");
    expect(metadata("Parser")).toHaveTextContent("9.1.1");
    expect(metadata("Bundle schema")).toHaveTextContent("1");
  });

  it("shows the exact published version and full source revision", () => {
    const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
    renderRelease({
      ...DEFAULT_RUNTIME_CONFIG_RESPONSE,
      release: {
        channel: "RELEASE",
        version: "1.2.3",
        sourceRevision,
        imageReference: "ghcr.io/hojooo/er-diagram:1.2.3",
        parserVersion: "9.1.1",
        bundleSchemaVersion: 1,
      },
    });

    expect(screen.getByText("Published image")).toBeInTheDocument();
    expect(metadata("Image version")).toHaveTextContent("1.2.3");
    expect(metadata("Source revision")).toHaveTextContent(sourceRevision);
  });
});

function renderRelease(config: RuntimeConfigResponse): void {
  render(
    <RuntimeConfigProvider config={config}>
      <RuntimeReleaseDetails />
    </RuntimeConfigProvider>,
  );
}

function metadata(label: string): HTMLElement {
  const term = screen.getByText(label);
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`Missing metadata value for ${label}.`);
  return value;
}
