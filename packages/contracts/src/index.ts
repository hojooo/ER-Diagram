import { z } from "zod";

export const contractPackage = "@er-diagram/contracts";

export const primaryDialectSchema = z.enum(["POSTGRESQL", "MYSQL"]);
export type PrimaryDialect = z.infer<typeof primaryDialectSchema>;

export const sourceRangeSchema = z
  .object({
    filepath: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.endOffset < range.startOffset) {
      context.addIssue({
        code: "custom",
        message: "endOffset must be greater than or equal to startOffset.",
        path: ["endOffset"],
      });
    }
    if (range.endLine < range.startLine) {
      context.addIssue({
        code: "custom",
        message: "endLine must be greater than or equal to startLine.",
        path: ["endLine"],
      });
    }
    if (range.endLine === range.startLine && range.endColumn < range.startColumn) {
      context.addIssue({
        code: "custom",
        message: "endColumn must be greater than or equal to startColumn on the same line.",
        path: ["endColumn"],
      });
    }
  });
export type SourceRange = z.infer<typeof sourceRangeSchema>;

export const diagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["ERROR", "WARNING", "INFO"]),
    range: sourceRangeSchema.optional(),
  })
  .strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;
