import { z } from "zod";

export const contractPackage = "@er-diagram/contracts";

export const primaryDialectSchema = z.enum(["POSTGRESQL", "MYSQL"]);
export type PrimaryDialect = z.infer<typeof primaryDialectSchema>;

export const diagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["ERROR", "WARNING", "INFO"]),
  range: z
    .object({
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
      startLine: z.number().int().positive(),
      startColumn: z.number().int().positive(),
      endLine: z.number().int().positive(),
      endColumn: z.number().int().positive(),
    })
    .optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
