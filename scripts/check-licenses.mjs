import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootArgumentIndex = process.argv.indexOf("--root");
const requestedRoot = rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined;

if (rootArgumentIndex >= 0 && !requestedRoot) {
  console.error("Usage: node scripts/check-licenses.mjs [--root <project-directory>]");
  process.exit(2);
}

const rootDirectory = requestedRoot
  ? path.resolve(requestedRoot)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(rootDirectory, "scripts", "license-inventory.json");
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const ignoredDirectories = new Set([
  ".git",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const allowedSelectedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "EPL-2.0",
  "ISC",
  "MIT",
  "MPL-2.0",
]);
const knownLicenseExpressions = new Set([
  ...allowedSelectedLicenses,
  "EPL-2.0 OR GPL-3.0-or-later",
  "MIT OR Apache-2.0",
]);
const forbiddenLicensePattern =
  /(?:^|\b)(?:AGPL|BUSL|CC-BY-NC|Commons Clause|SSPL|UNLICENSED|UNKNOWN)(?:\b|$)/i;
const placeholderPattern =
  /\b(?:CHANGEME|FIXME|PLACEHOLDER|TBD|TODO)\b|\b(?:INSERT|YOUR)\s+(?:COMPANY|NAME|ORGANIZATION)\b/i;
const exactVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const errors = [];

function readText(relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);

  if (!fs.existsSync(absolutePath)) {
    errors.push(`Missing required file: ${relativePath}`);
    return "";
  }

  return fs.readFileSync(absolutePath, "utf8");
}

function reportPlaceholders(relativePath, contents) {
  const match = contents.match(placeholderPattern);

  if (match) {
    errors.push(`${relativePath} contains an unresolved placeholder: ${match[0]}`);
  }
}

function validateProjectFiles() {
  const license = readText("LICENSE");
  const notice = readText("NOTICE");
  const thirdPartyNotices = readText("THIRD_PARTY_NOTICES.md");

  const requiredLicenseMarkers = [
    "Apache License\n                           Version 2.0, January 2004",
    "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    "1. Definitions.",
    "9. Accepting Warranty or Additional Liability.",
    "END OF TERMS AND CONDITIONS",
    "APPENDIX: How to apply the Apache License to your work.",
  ];

  if (license.length < 10_000) {
    errors.push("LICENSE is too short to contain the complete Apache License 2.0 text.");
  }

  for (const marker of requiredLicenseMarkers) {
    if (!license.includes(marker)) {
      errors.push(`LICENSE is missing required Apache-2.0 text: ${marker}`);
    }
  }

  const requiredNoticeMarkers = [
    "DBML·SQL ERD Studio",
    "Copyright 2026 hojooo",
    "Licensed under the Apache License, Version 2.0",
    "THIRD_PARTY_NOTICES.md",
  ];

  for (const marker of requiredNoticeMarkers) {
    if (!notice.includes(marker)) {
      errors.push(`NOTICE is missing required entry: ${marker}`);
    }
  }

  if (!thirdPartyNotices.includes("SPDX-License-Identifier: Apache-2.0")) {
    errors.push("THIRD_PARTY_NOTICES.md is missing the project SPDX identifier.");
  }

  reportPlaceholders("NOTICE", notice);
  reportPlaceholders("THIRD_PARTY_NOTICES.md", thirdPartyNotices);

  return thirdPartyNotices;
}

function loadInventory() {
  const rawInventory = readText(path.relative(rootDirectory, inventoryPath));

  if (!rawInventory) {
    return [];
  }

  reportPlaceholders("scripts/license-inventory.json", rawInventory);

  try {
    const parsed = JSON.parse(rawInventory);

    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.packages)) {
      errors.push("scripts/license-inventory.json must use schemaVersion 1 and a packages array.");
      return [];
    }

    return parsed.packages;
  } catch (error) {
    errors.push(`scripts/license-inventory.json is not valid JSON: ${error.message}`);
    return [];
  }
}

function validateInventory(packages, thirdPartyNotices) {
  const packagesByName = new Map();
  const sortedNames = packages.map(({ name }) => name).toSorted();

  if (JSON.stringify(sortedNames) !== JSON.stringify(packages.map(({ name }) => name))) {
    errors.push("scripts/license-inventory.json package entries must be sorted by name.");
  }

  for (const dependency of packages) {
    const { licenseExpression, name, selectedLicense, source, upstreamNotice, version } =
      dependency;
    const effectiveLicense = selectedLicense ?? licenseExpression;

    if (!name || packagesByName.has(name)) {
      errors.push(`Inventory package name is missing or duplicated: ${name ?? "<missing>"}`);
      continue;
    }

    packagesByName.set(name, dependency);

    if (name === "@dbml/connector") {
      errors.push("@dbml/connector is forbidden as a direct dependency and inventory entry in P0.");
    }

    if (!exactVersionPattern.test(version ?? "")) {
      errors.push(`${name} inventory version is not exact: ${version ?? "<missing>"}`);
    }

    if (!knownLicenseExpressions.has(licenseExpression)) {
      errors.push(
        `${name}@${version} has an unknown license expression: ${licenseExpression ?? "<missing>"}`,
      );
    }

    if (
      !allowedSelectedLicenses.has(effectiveLicense) ||
      forbiddenLicensePattern.test(effectiveLicense)
    ) {
      errors.push(
        `${name}@${version} selects a forbidden or unknown license: ${effectiveLicense ?? "<missing>"}`,
      );
    }

    if (licenseExpression?.includes(" OR ")) {
      const choices = licenseExpression.split(" OR ");

      if (!selectedLicense || !choices.includes(selectedLicense)) {
        errors.push(
          `${name}@${version} must select one allowed license from ${licenseExpression}.`,
        );
      }
    }

    if (typeof source !== "string" || !source.startsWith("https://")) {
      errors.push(`${name}@${version} must have an HTTPS source URL in the inventory.`);
    }

    const noticeRow = `| \`${name}\` | \`${version}\` | \`${licenseExpression}\` | \`${effectiveLicense}\` |`;

    if (!thirdPartyNotices.includes(noticeRow)) {
      errors.push(`THIRD_PARTY_NOTICES.md is missing the inventory row for ${name}@${version}.`);
    }

    if (!thirdPartyNotices.includes(source)) {
      errors.push(`THIRD_PARTY_NOTICES.md is missing the source link for ${name}@${version}.`);
    }

    if (upstreamNotice) {
      const noticeMarker = `\`${name}@${version}\` — \`${upstreamNotice}\``;

      if (!thirdPartyNotices.includes(noticeMarker)) {
        errors.push(
          `THIRD_PARTY_NOTICES.md is missing the upstream notice entry for ${name}@${version}.`,
        );
      }
    }
  }

  const requiredElkMarkers = [
    "## ELK.js source availability",
    "EPL-2.0 OR GPL-3.0-or-later",
    "EPL-2.0 option",
    "https://registry.npmjs.org/elkjs/-/elkjs-0.12.0.tgz",
  ];

  for (const marker of requiredElkMarkers) {
    if (!thirdPartyNotices.includes(marker)) {
      errors.push(`THIRD_PARTY_NOTICES.md is missing ELK.js guidance: ${marker}`);
    }
  }

  return packagesByName;
}

function findPackageJsonFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === "package.json") {
        results.push(path.join(directory, entry.name));
      }
      continue;
    }

    if (!ignoredDirectories.has(entry.name)) {
      findPackageJsonFiles(path.join(directory, entry.name), results);
    }
  }

  return results;
}

function loadWorkspaceManifests() {
  return findPackageJsonFiles(rootDirectory).flatMap((manifestPath) => {
    try {
      return [
        {
          manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
          relativePath: path.relative(rootDirectory, manifestPath),
        },
      ];
    } catch (error) {
      errors.push(
        `${path.relative(rootDirectory, manifestPath)} is not valid JSON: ${error.message}`,
      );
      return [];
    }
  });
}

function validateDirectDependencies(packagesByName) {
  const workspaceManifests = loadWorkspaceManifests();
  const workspacePackageNames = new Set(
    workspaceManifests.map(({ manifest }) => manifest.name).filter(Boolean),
  );
  let directDependencyCount = 0;

  for (const { manifest, relativePath } of workspaceManifests) {
    if (relativePath === "package.json" && manifest.license !== "Apache-2.0") {
      errors.push(
        `${relativePath} must declare SPDX license Apache-2.0, not ${manifest.license ?? "<missing>"}.`,
      );
    } else if (manifest.license && manifest.license !== "Apache-2.0") {
      errors.push(
        `${relativePath} must use the project license Apache-2.0, not ${manifest.license}.`,
      );
    }

    for (const section of dependencySections) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (name === "@dbml/connector") {
          errors.push(
            `${relativePath} declares forbidden P0 dependency @dbml/connector in ${section}.`,
          );
          continue;
        }

        if (workspacePackageNames.has(name)) {
          if (!version.startsWith("workspace:")) {
            errors.push(
              `${relativePath} must reference internal package ${name} with the workspace: protocol.`,
            );
          }
          continue;
        }

        directDependencyCount += 1;

        if (!exactVersionPattern.test(version)) {
          errors.push(`${relativePath} has non-exact ${section} version for ${name}: ${version}`);
        }

        const inventoryEntry = packagesByName.get(name);

        if (!inventoryEntry) {
          errors.push(
            `${relativePath} declares ${name}@${version}, but it is missing from scripts/license-inventory.json.`,
          );
        } else if (inventoryEntry.version !== version) {
          errors.push(
            `${relativePath} declares ${name}@${version}, but the inventory records ${inventoryEntry.version}.`,
          );
        }
      }
    }
  }

  return directDependencyCount;
}

function collectInstalledPackageMetadata() {
  const virtualStore = path.join(rootDirectory, "node_modules", ".pnpm");
  const installed = new Map();

  if (!fs.existsSync(virtualStore)) {
    return installed;
  }

  for (const storeEntry of fs.readdirSync(virtualStore)) {
    const modulesDirectory = path.join(virtualStore, storeEntry, "node_modules");

    if (!fs.existsSync(modulesDirectory)) {
      continue;
    }

    for (const firstLevelName of fs.readdirSync(modulesDirectory)) {
      const firstLevelPath = path.join(modulesDirectory, firstLevelName);
      const candidateDirectories = firstLevelName.startsWith("@")
        ? fs
            .readdirSync(firstLevelPath)
            .map((secondLevelName) => path.join(firstLevelPath, secondLevelName))
        : [firstLevelPath];

      for (const candidateDirectory of candidateDirectories) {
        const manifestPath = path.join(candidateDirectory, "package.json");

        if (!fs.existsSync(manifestPath)) {
          continue;
        }

        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          installed.set(`${manifest.name}@${manifest.version}`, manifest);
        } catch {
          // pnpm owns virtual-store metadata. Invalid files are handled by pnpm itself.
        }
      }
    }
  }

  return installed;
}

function validateInstalledMetadata(packages) {
  const installed = collectInstalledPackageMetadata();

  if (installed.size === 0) {
    return false;
  }

  for (const dependency of packages) {
    const key = `${dependency.name}@${dependency.version}`;
    const manifest = installed.get(key);

    if (!manifest) {
      errors.push(
        `Installed dependency metadata is missing for ${key}; run pnpm install --frozen-lockfile.`,
      );
      continue;
    }

    if (manifest.license !== dependency.licenseExpression) {
      errors.push(
        `${key} declares ${manifest.license ?? "no license"}, but the inventory records ${dependency.licenseExpression}.`,
      );
    }
  }

  return true;
}

const thirdPartyNotices = validateProjectFiles();
const packages = loadInventory();
const packagesByName = validateInventory(packages, thirdPartyNotices);
const directDependencyCount = validateDirectDependencies(packagesByName);
const installedMetadataChecked = validateInstalledMetadata(packages);

if (errors.length > 0) {
  console.error(`License check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  const installationStatus = installedMetadataChecked
    ? "installed metadata verified"
    : "pre-install mode; installed metadata skipped";
  console.log(
    `License check passed: ${packages.length} inventory entries, ${directDependencyCount} direct declarations, ${installationStatus}.`,
  );
}
