import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export async function assertNoWcagViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze();
  if (result.violations.length === 0) return;

  const details = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target.map(String)),
  }));
  throw new Error(
    `WCAG A/AA violations found in ${stateName}:\n${JSON.stringify(details, null, 2)}`,
  );
}
