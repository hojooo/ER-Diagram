import type { VisualCommand } from "@er-diagram/contracts";
import type {
  DbmlParseResult,
  SqlExportConversionInput,
  SqlExportConversionResult,
  SqlImportConversionInput,
  SqlImportConversionResult,
  VisualCommandTransformResult,
} from "@er-diagram/core";

import type { ResourceOperationErrorCode } from "./resource-errors.js";

export type ResourceWorkerOperation =
  | {
      readonly type: "PARSE_DBML";
      readonly source: string;
      readonly filepath: string;
    }
  | {
      readonly type: "CONVERT_SQL_IMPORT";
      readonly input: SqlImportConversionInput;
    }
  | {
      readonly type: "CONVERT_SQL_EXPORT";
      readonly input: SqlExportConversionInput;
    }
  | {
      readonly type: "TRANSFORM_VISUAL_COMMAND";
      readonly source: string;
      readonly command: VisualCommand;
      readonly filepath: string;
    }
  | { readonly type: "TEST_CRASH" }
  | { readonly type: "TEST_HANG" }
  | { readonly type: "TEST_OOM" }
  | { readonly type: "TEST_PROTOCOL" };

export interface ResourceWorkerRequest {
  readonly requestId: string;
  readonly operation: ResourceWorkerOperation;
}

export type ResourceWorkerResponse =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly error: { readonly code: ResourceOperationErrorCode };
    };

export interface ResourceOperationResultMap {
  readonly PARSE_DBML: DbmlParseResult;
  readonly CONVERT_SQL_IMPORT: SqlImportConversionResult;
  readonly CONVERT_SQL_EXPORT: SqlExportConversionResult;
  readonly TRANSFORM_VISUAL_COMMAND: VisualCommandTransformResult;
  readonly TEST_CRASH: never;
  readonly TEST_HANG: never;
  readonly TEST_OOM: never;
  readonly TEST_PROTOCOL: never;
}
