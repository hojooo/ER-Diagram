import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { Enums, Models, Serialize, Spec } from "@cyclonedx/cyclonedx-library";

export const CYCLONEDX_SPEC_VERSION = "1.6";
export const CYCLONEDX_LIBRARY_VERSION = "10.2.0";
export const PRODUCTION_ROOT_PACKAGES = Object.freeze(["@er-diagram/server", "@er-diagram/web"]);

const APPLICATION_NAME = "DBML SQL ERD Studio";
const APPLICATION_PACKAGE_NAME = "er-diagram";
const APPLICATION_SOURCE = "https://github.com/hojooo/ER-Diagram";
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const FULL_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "EPL-2.0",
  "ISC",
  "MIT",
]);
const ALLOWED_DECLARED_EXPRESSIONS = new Set([
  ...ALLOWED_LICENSES,
  "(MPL-2.0 OR Apache-2.0)",
  "EPL-2.0 OR GPL-3.0-or-later",
]);

export class SbomEvidenceError extends Error {
  constructor(code, message = "SBOM evidence validation failed.") {
    super(message);
    this.name = "SbomEvidenceError";
    this.code = code;
  }
}

export function collectProductionDependencyRecords(repositoryRoot) {
  const roots = JSON.parse(
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@er-diagram/server",
        "--filter",
        "@er-diagram/web",
        "list",
        "--prod",
        "--depth",
        "Infinity",
        "--json",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  if (!Array.isArray(roots)) throw sbomError("SBOM_PNPM_GRAPH_INVALID");

  const actualRootNames = roots.map(({ name }) => name).toSorted(codeUnitCompare);
  if (JSON.stringify(actualRootNames) !== JSON.stringify([...PRODUCTION_ROOT_PACKAGES])) {
    throw sbomError("SBOM_PNPM_ROOT_SET_INVALID");
  }

  const inventory = loadLicenseInventory(repositoryRoot);
  const selectedLicenses = createSelectedLicenseMap(inventory);
  const records = new Map();

  function visit(node, dependencyName) {
    assertPlainObject(node, "SBOM_PNPM_NODE_INVALID");
    if (typeof node.path !== "string" || !isAbsolute(node.path)) {
      throw sbomError("SBOM_PNPM_NODE_PATH_INVALID");
    }

    const manifest = readJson(join(node.path, "package.json"), "SBOM_PACKAGE_MANIFEST_INVALID");
    const name = manifest.name ?? dependencyName;
    const version = manifest.version;
    if (typeof name !== "string" || !EXACT_VERSION_PATTERN.test(version ?? "")) {
      throw sbomError("SBOM_PACKAGE_IDENTITY_INVALID");
    }

    const internal = isInternalWorkspacePackage(repositoryRoot, node.path, name);
    const declaredLicense = internal ? "Apache-2.0" : manifest.license;
    if (typeof declaredLicense !== "string" || !ALLOWED_DECLARED_EXPRESSIONS.has(declaredLicense)) {
      throw sbomError("SBOM_PACKAGE_LICENSE_UNREVIEWED");
    }

    const selection = selectedLicenses.get(`${name}@${version}`);
    if (selection && selection.licenseExpression !== declaredLicense) {
      throw sbomError("SBOM_PACKAGE_LICENSE_POLICY_MISMATCH");
    }
    const selectedLicense = selection?.selectedLicense ?? declaredLicense;
    if (!ALLOWED_LICENSES.has(selectedLicense)) {
      throw sbomError("SBOM_PACKAGE_LICENSE_SELECTION_REQUIRED");
    }
    if (declaredLicense.includes(" OR ") && !selection) {
      throw sbomError("SBOM_PACKAGE_LICENSE_SELECTION_REQUIRED");
    }

    const key = packageKey(name, version);
    const source = internal
      ? APPLICATION_SOURCE
      : (selection?.source ?? normalizeSourceUrl(manifest.repository) ?? manifest.homepage);
    const record = records.get(key) ?? {
      dependencies: new Set(),
      internal,
      licenseExpression: declaredLicense,
      name,
      selectedLicense,
      source: normalizeHttpsUrl(source),
      version,
    };
    if (
      record.name !== name ||
      record.version !== version ||
      record.licenseExpression !== declaredLicense ||
      record.selectedLicense !== selectedLicense ||
      record.internal !== internal ||
      record.source !== normalizeHttpsUrl(source)
    ) {
      throw sbomError("SBOM_PACKAGE_IDENTITY_COLLISION");
    }
    records.set(key, record);

    for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
      const childKey = visit(child, childName);
      record.dependencies.add(childKey);
    }

    return key;
  }

  for (const root of roots) visit(root, root.name);

  return Object.freeze(
    [...records.entries()]
      .toSorted(([left], [right]) => codeUnitCompare(left, right))
      .map(([key, record]) =>
        Object.freeze({
          ...record,
          dependencies: Object.freeze([...record.dependencies].toSorted(codeUnitCompare)),
          key,
        }),
      ),
  );
}

export function createCycloneDxSbom({ imageReference, records, revision, version }) {
  validateReleaseIdentity({ imageReference, revision, version });
  if (!Array.isArray(records) || records.length === 0) {
    throw sbomError("SBOM_COMPONENT_SET_INVALID");
  }

  const recordsByKey = new Map();
  for (const record of records) {
    validateRecord(record);
    if (recordsByKey.has(record.key)) throw sbomError("SBOM_COMPONENT_DUPLICATE");
    recordsByKey.set(record.key, record);
  }

  const componentsByKey = new Map();
  for (const record of records.toSorted((left, right) => codeUnitCompare(left.key, right.key))) {
    const purl = npmPurl(record.name, record.version);
    const properties = [];
    if (record.licenseExpression !== record.selectedLicense) {
      properties.push(
        new Models.Property("er-diagram:license:declared", record.licenseExpression),
        new Models.Property("er-diagram:license:selected", record.selectedLicense),
      );
    }
    const externalReferences = record.source
      ? new Models.ExternalReferenceRepository([
          new Models.ExternalReference(record.source, Enums.ExternalReferenceType.VCS),
        ])
      : undefined;
    const component = new Models.Component(
      record.name === "@er-diagram/server" || record.name === "@er-diagram/web"
        ? Enums.ComponentType.Application
        : Enums.ComponentType.Library,
      record.name,
      {
        bomRef: purl,
        externalReferences,
        licenses: new Models.LicenseRepository([new Models.SpdxLicense(record.selectedLicense)]),
        properties: new Models.PropertyRepository(properties),
        purl,
        scope: Enums.ComponentScope.Required,
        version: record.version,
      },
    );
    componentsByKey.set(record.key, component);
  }

  for (const record of records) {
    const component = componentsByKey.get(record.key);
    for (const dependencyKey of record.dependencies) {
      const dependency = componentsByKey.get(dependencyKey);
      if (!dependency) throw sbomError("SBOM_DEPENDENCY_TARGET_MISSING");
      component.dependencies.add(dependency.bomRef);
    }
  }

  const applicationPurl = npmPurl(APPLICATION_PACKAGE_NAME, version);
  const application = new Models.Component(Enums.ComponentType.Application, APPLICATION_NAME, {
    bomRef: applicationPurl,
    externalReferences: new Models.ExternalReferenceRepository([
      new Models.ExternalReference(APPLICATION_SOURCE, Enums.ExternalReferenceType.VCS),
      new Models.ExternalReference(imageReference, Enums.ExternalReferenceType.Distribution),
    ]),
    licenses: new Models.LicenseRepository([new Models.SpdxLicense("Apache-2.0")]),
    properties: new Models.PropertyRepository([
      new Models.Property("er-diagram:release:image-reference", imageReference),
      new Models.Property("er-diagram:release:source-revision", revision),
    ]),
    purl: applicationPurl,
    version,
  });
  for (const rootName of PRODUCTION_ROOT_PACKAGES) {
    const root = [...recordsByKey.values()].find(({ name }) => name === rootName);
    if (!root) throw sbomError("SBOM_ROOT_COMPONENT_MISSING");
    application.dependencies.add(componentsByKey.get(root.key).bomRef);
  }

  const metadata = new Models.Metadata({
    component: application,
    tools: new Models.Tools({
      tools: new Models.ToolRepository([
        new Models.Tool({
          name: "@cyclonedx/cyclonedx-library",
          vendor: "OWASP Foundation",
          version: CYCLONEDX_LIBRARY_VERSION,
        }),
      ]),
    }),
  });
  const bom = new Models.Bom({
    components: new Models.ComponentRepository(componentsByKey.values()),
    metadata,
  });
  const serializer = new Serialize.JsonSerializer(
    new Serialize.JSON.Normalize.Factory(Spec.Spec1dot6),
  );
  const normalized = JSON.parse(serializer.serialize(bom, { sortLists: true }));
  canonicalizeCycloneDxArrays(normalized);
  const serialized = `${JSON.stringify(sortObjectKeys(normalized), null, 2)}\n`;
  const document = JSON.parse(serialized);
  validateCycloneDxDocument(document, { imageReference, revision, version });

  return Object.freeze({
    bytes: Buffer.byteLength(serialized, "utf8"),
    componentCount: document.components.length,
    document,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    text: serialized,
  });
}

export function validateCycloneDxDocument(document, expected) {
  assertPlainObject(document, "SBOM_DOCUMENT_INVALID");
  if (
    document.$schema !== "http://cyclonedx.org/schema/bom-1.6.schema.json" ||
    document.bomFormat !== "CycloneDX" ||
    document.specVersion !== CYCLONEDX_SPEC_VERSION ||
    document.version !== 1 ||
    "serialNumber" in document
  ) {
    throw sbomError("SBOM_DOCUMENT_CONTRACT_INVALID");
  }
  assertPlainObject(document.metadata, "SBOM_METADATA_INVALID");
  if ("timestamp" in document.metadata) throw sbomError("SBOM_TIMESTAMP_FORBIDDEN");
  assertPlainObject(document.metadata.component, "SBOM_APPLICATION_COMPONENT_INVALID");

  const application = document.metadata.component;
  const applicationRef = npmPurl(APPLICATION_PACKAGE_NAME, expected.version);
  if (
    application["bom-ref"] !== applicationRef ||
    application.purl !== applicationRef ||
    application.version !== expected.version
  ) {
    throw sbomError("SBOM_APPLICATION_COMPONENT_INVALID");
  }
  const applicationProperties = new Map(
    (application.properties ?? []).map(({ name, value }) => [name, value]),
  );
  if (
    applicationProperties.get("er-diagram:release:image-reference") !== expected.imageReference ||
    applicationProperties.get("er-diagram:release:source-revision") !== expected.revision
  ) {
    throw sbomError("SBOM_RELEASE_IDENTITY_INVALID");
  }

  if (!Array.isArray(document.components) || !Array.isArray(document.dependencies)) {
    throw sbomError("SBOM_COMPONENT_SET_INVALID");
  }
  const componentRefs = document.components.map((component) => {
    assertPlainObject(component, "SBOM_COMPONENT_INVALID");
    const ref = component["bom-ref"];
    const expectedRef = npmPurl(component.name, component.version);
    if (
      typeof ref !== "string" ||
      typeof component.name !== "string" ||
      !EXACT_VERSION_PATTERN.test(component.version ?? "") ||
      !["application", "library"].includes(component.type) ||
      ref !== expectedRef ||
      component.purl !== ref ||
      component.scope !== "required" ||
      !Array.isArray(component.licenses) ||
      component.licenses.length !== 1 ||
      !ALLOWED_LICENSES.has(component.licenses[0]?.license?.id)
    ) {
      throw sbomError("SBOM_COMPONENT_INVALID");
    }
    if (
      !Array.isArray(component.externalReferences) ||
      !component.externalReferences.some(({ type }) => type === "vcs")
    ) {
      throw sbomError("SBOM_COMPONENT_SOURCE_INVALID");
    }
    for (const reference of component.externalReferences) {
      if (typeof reference.url !== "string" || !reference.url.startsWith("https://")) {
        throw sbomError("SBOM_COMPONENT_SOURCE_INVALID");
      }
    }
    return ref;
  });
  assertSortedUnique(componentRefs, "SBOM_COMPONENT_ORDER_INVALID");

  const validRefs = new Set([applicationRef, ...componentRefs]);
  const dependencyRefs = document.dependencies.map(({ ref, dependsOn = [] }) => {
    if (!validRefs.has(ref) || !Array.isArray(dependsOn)) {
      throw sbomError("SBOM_DEPENDENCY_INVALID");
    }
    assertSortedUnique(dependsOn, "SBOM_DEPENDENCY_ORDER_INVALID");
    if (dependsOn.some((dependency) => !validRefs.has(dependency))) {
      throw sbomError("SBOM_DEPENDENCY_TARGET_MISSING");
    }
    return ref;
  });
  assertSortedUnique(dependencyRefs, "SBOM_DEPENDENCY_ORDER_INVALID");
  if (
    dependencyRefs.length !== validRefs.size ||
    dependencyRefs.some((ref) => !validRefs.has(ref))
  ) {
    throw sbomError("SBOM_DEPENDENCY_CLOSURE_INVALID");
  }
  const applicationDependency = document.dependencies.find(({ ref }) => ref === applicationRef);
  const requiredRootRefs = PRODUCTION_ROOT_PACKAGES.map((rootName) => {
    const rootComponent = document.components.find(({ name }) => name === rootName);
    if (!rootComponent) throw sbomError("SBOM_ROOT_COMPONENT_MISSING");
    return rootComponent["bom-ref"];
  }).toSorted(codeUnitCompare);
  if (
    !applicationDependency ||
    JSON.stringify(applicationDependency.dependsOn ?? []) !== JSON.stringify(requiredRootRefs)
  ) {
    throw sbomError("SBOM_ROOT_DEPENDENCY_INVALID");
  }

  return Object.freeze({
    applicationRef,
    componentCount: componentRefs.length,
    dependencyCount: dependencyRefs.length,
  });
}

export function npmPurl(name, version) {
  const scoped = /^@([^/]+)\/(.+)$/u.exec(name);
  const encodedName = scoped
    ? `%40${encodeURIComponent(scoped[1])}/${encodeURIComponent(scoped[2])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function loadLicenseInventory(repositoryRoot) {
  const inventory = readJson(
    join(repositoryRoot, "scripts", "license-inventory.json"),
    "SBOM_LICENSE_INVENTORY_INVALID",
  );
  if (
    inventory.schemaVersion !== 2 ||
    !Array.isArray(inventory.packages) ||
    !Array.isArray(inventory.productionLicenseSelections)
  ) {
    throw sbomError("SBOM_LICENSE_INVENTORY_INVALID");
  }
  return inventory;
}

function createSelectedLicenseMap(inventory) {
  const selections = new Map();
  for (const entry of [...inventory.packages, ...inventory.productionLicenseSelections]) {
    if (!entry.selectedLicense) continue;
    const key = packageKey(entry.name, entry.version);
    if (selections.has(key)) throw sbomError("SBOM_LICENSE_POLICY_DUPLICATE");
    selections.set(key, entry);
  }
  return selections;
}

function validateRecord(record) {
  assertPlainObject(record, "SBOM_COMPONENT_INVALID");
  if (
    record.key !== packageKey(record.name, record.version) ||
    !EXACT_VERSION_PATTERN.test(record.version ?? "") ||
    !ALLOWED_DECLARED_EXPRESSIONS.has(record.licenseExpression) ||
    !ALLOWED_LICENSES.has(record.selectedLicense) ||
    !Array.isArray(record.dependencies) ||
    typeof record.source !== "string" ||
    normalizeHttpsUrl(record.source) !== record.source
  ) {
    throw sbomError("SBOM_COMPONENT_INVALID");
  }
  assertSortedUnique(record.dependencies, "SBOM_DEPENDENCY_ORDER_INVALID");
}

function validateReleaseIdentity({ imageReference, revision, version }) {
  if (!EXACT_VERSION_PATTERN.test(version ?? "")) throw sbomError("SBOM_VERSION_INVALID");
  if (!FULL_REVISION_PATTERN.test(revision ?? "")) throw sbomError("SBOM_REVISION_INVALID");
  if (imageReference !== `ghcr.io/hojooo/er-diagram:${version}`) {
    throw sbomError("SBOM_IMAGE_REFERENCE_INVALID");
  }
}

function isInternalWorkspacePackage(repositoryRoot, packagePath, name) {
  const packageRelativePath = relative(repositoryRoot, packagePath);
  return (
    name.startsWith("@er-diagram/") &&
    !packageRelativePath.startsWith("..") &&
    !packageRelativePath.split(/[\\/]/u).includes("node_modules")
  );
}

function normalizeSourceUrl(repository) {
  let value = typeof repository === "string" ? repository : repository?.url;
  if (typeof value !== "string") return undefined;
  if (/^[^/:\s]+\/[^/\s]+$/u.test(value)) value = `https://github.com/${value}`;
  value = value.replace(/^git\+/u, "");
  value = value.replace(/^git:\/\/github\.com\//u, "https://github.com/");
  value = value.replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/");
  value = value.replace(/^git@github\.com:/u, "https://github.com/");
  value = value.replace(/\.git(?:#.*)?$/u, "");
  return normalizeHttpsUrl(value);
}

function normalizeHttpsUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return undefined;
  try {
    return new URL(value).toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function canonicalizeCycloneDxArrays(document) {
  document.components?.sort((left, right) => codeUnitCompare(left["bom-ref"], right["bom-ref"]));
  document.dependencies?.sort((left, right) => codeUnitCompare(left.ref, right.ref));
  for (const dependency of document.dependencies ?? []) {
    dependency.dependsOn?.sort(codeUnitCompare);
  }
  for (const component of [document.metadata?.component, ...(document.components ?? [])]) {
    component?.externalReferences?.sort((left, right) =>
      codeUnitCompare(`${left.type}:${left.url}`, `${right.type}:${right.url}`),
    );
    component?.licenses?.sort((left, right) =>
      codeUnitCompare(
        left.license?.id ?? left.expression ?? "",
        right.license?.id ?? right.expression ?? "",
      ),
    );
    component?.properties?.sort((left, right) =>
      codeUnitCompare(`${left.name}:${left.value}`, `${right.name}:${right.value}`),
    );
  }
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => codeUnitCompare(left, right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

function packageKey(name, version) {
  return `${name}@${version}`;
}

function assertSortedUnique(values, code) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string") ||
    JSON.stringify(values) !== JSON.stringify([...new Set(values)].toSorted(codeUnitCompare))
  ) {
    throw sbomError(code);
  }
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(filename, code) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw sbomError(code);
  }
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw sbomError(code);
  }
}

function sbomError(code) {
  return new SbomEvidenceError(code);
}
