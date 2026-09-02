import assert from "node:assert/strict";
import test from "node:test";

import {
  createCycloneDxSbom,
  npmPurl,
  SbomEvidenceError,
  validateCycloneDxDocument,
} from "./sbom-evidence.mjs";

const identity = Object.freeze({
  imageReference: "ghcr.io/hojooo/er-diagram:1.2.3",
  revision: "0123456789abcdef0123456789abcdef01234567",
  version: "1.2.3",
});

function fixtureRecords() {
  return [
    {
      dependencies: ["react@19.2.8"],
      internal: true,
      key: "@er-diagram/server@0.0.0",
      licenseExpression: "Apache-2.0",
      name: "@er-diagram/server",
      selectedLicense: "Apache-2.0",
      source: "https://github.com/hojooo/ER-Diagram",
      version: "0.0.0",
    },
    {
      dependencies: ["dompurify@3.4.8"],
      internal: true,
      key: "@er-diagram/web@0.0.0",
      licenseExpression: "Apache-2.0",
      name: "@er-diagram/web",
      selectedLicense: "Apache-2.0",
      source: "https://github.com/hojooo/ER-Diagram",
      version: "0.0.0",
    },
    {
      dependencies: [],
      internal: false,
      key: "dompurify@3.4.8",
      licenseExpression: "(MPL-2.0 OR Apache-2.0)",
      name: "dompurify",
      selectedLicense: "Apache-2.0",
      source: "https://github.com/cure53/DOMPurify",
      version: "3.4.8",
    },
    {
      dependencies: [],
      internal: false,
      key: "react@19.2.8",
      licenseExpression: "MIT",
      name: "react",
      selectedLicense: "MIT",
      source: "https://github.com/facebook/react",
      version: "19.2.8",
    },
  ];
}

test("creates deterministic CycloneDX 1.6 application evidence", () => {
  const first = createCycloneDxSbom({ ...identity, records: fixtureRecords() });
  const second = createCycloneDxSbom({ ...identity, records: fixtureRecords() });

  assert.equal(first.text, second.text);
  assert.equal(first.document.bomFormat, "CycloneDX");
  assert.equal(first.document.specVersion, "1.6");
  assert.equal(first.document.metadata.timestamp, undefined);
  assert.equal(first.document.serialNumber, undefined);
  assert.deepEqual(
    first.document.components.map(({ "bom-ref": ref }) => ref),
    [
      npmPurl("@er-diagram/server", "0.0.0"),
      npmPurl("@er-diagram/web", "0.0.0"),
      npmPurl("dompurify", "3.4.8"),
      npmPurl("react", "19.2.8"),
    ].toSorted(),
  );
  assert.equal(
    first.document.components.find(({ name }) => name === "dompurify").licenses[0].license.id,
    "Apache-2.0",
  );
  assert.deepEqual(first.document.components.find(({ name }) => name === "dompurify").properties, [
    { name: "er-diagram:license:declared", value: "(MPL-2.0 OR Apache-2.0)" },
    { name: "er-diagram:license:selected", value: "Apache-2.0" },
  ]);
  assert.doesNotThrow(() => validateCycloneDxDocument(first.document, identity));
  assert.doesNotThrow(() => structuredClone(first.document));
  assert.deepEqual(JSON.parse(JSON.stringify(first.document)), first.document);
});

test("rejects duplicate components and missing dependency targets", () => {
  assert.throws(
    () =>
      createCycloneDxSbom({
        ...identity,
        records: [...fixtureRecords(), fixtureRecords()[0]],
      }),
    (error) => error instanceof SbomEvidenceError && error.code === "SBOM_COMPONENT_DUPLICATE",
  );

  const records = fixtureRecords();
  records[0] = { ...records[0], dependencies: ["missing@1.0.0"] };
  assert.throws(
    () => createCycloneDxSbom({ ...identity, records }),
    (error) =>
      error instanceof SbomEvidenceError && error.code === "SBOM_DEPENDENCY_TARGET_MISSING",
  );
});

test("rejects non-canonical or environment-dependent evidence", () => {
  const result = createCycloneDxSbom({ ...identity, records: fixtureRecords() });
  const timestamped = structuredClone(result.document);
  timestamped.metadata.timestamp = "2026-09-01T00:00:00.000Z";
  assert.throws(
    () => validateCycloneDxDocument(timestamped, identity),
    (error) => error instanceof SbomEvidenceError && error.code === "SBOM_TIMESTAMP_FORBIDDEN",
  );

  const unsorted = structuredClone(result.document);
  unsorted.components.reverse();
  assert.throws(
    () => validateCycloneDxDocument(unsorted, identity),
    (error) => error instanceof SbomEvidenceError && error.code === "SBOM_COMPONENT_ORDER_INVALID",
  );
});
