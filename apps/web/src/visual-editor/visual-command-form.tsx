import {
  visualCommandSchema,
  type PrimaryDialect,
  type VisualColumnDefault,
  type VisualIndexTerm,
  type VisualReferenceEndpoint,
} from "@er-diagram/contracts";
import { getSqlBuiltinTypes, type SchemaGraph, type TableNode } from "@er-diagram/core";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { UiMessages } from "../localization/messages.js";
import { useUiLocale } from "../localization/ui-locale.js";
import type { VisualEditorAction } from "./visual-editor-model.js";
import { findColumn, normalizeVisualDraft } from "./visual-editor-model.js";
import type { VisualCommandDraft } from "./visual-command-session.js";

const VALIDATION_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";

export function VisualCommandForm({
  graph,
  primaryDialect,
  action,
  displayLabel,
  initialDraft,
  disabled,
  submitOnModEnter = false,
  onCancel,
  onSubmit,
}: {
  readonly graph: SchemaGraph;
  readonly primaryDialect: PrimaryDialect;
  readonly action: VisualEditorAction;
  readonly displayLabel?: string;
  readonly initialDraft: VisualCommandDraft;
  readonly disabled: boolean;
  readonly submitOnModEnter?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (draft: VisualCommandDraft) => void;
}) {
  const { messages } = useUiLocale();
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const typeSuggestions = useMemo(
    () => listTypeSuggestions(graph, primaryDialect),
    [graph, primaryDialect],
  );
  const destructive = isDeleteCommand(draft.kind);
  const structuralBlockers = destructive ? deleteStructuralBlockers(graph, draft, messages) : [];
  const formLabel = displayLabel ?? action.label;

  useEffect(() => {
    const form = formRef.current;
    if (!form || !error) return;
    const invalidControl = [...form.elements].find(
      (element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        !element.disabled &&
        !element.checkValidity(),
    );
    if (!invalidControl) {
      errorRef.current?.focus();
      return;
    }
    invalidControl.setAttribute("aria-invalid", "true");
    invalidControl.setAttribute("aria-errormessage", errorId);
    invalidControl.focus();
    return () => {
      invalidControl.removeAttribute("aria-invalid");
      invalidControl.removeAttribute("aria-errormessage");
    };
  }, [error, errorId]);

  const submit = () => {
    const normalized = normalizeVisualDraft(graph, draft);
    if (!normalized.draft) {
      setError(
        normalized.error === "Change at least one field before applying the command."
          ? messages["visual.changeAtLeastOne"]
          : normalized.error === "The selected schema element no longer exists."
            ? messages["visual.elementMissing"]
            : normalized.error,
      );
      return;
    }
    const parsed = visualCommandSchema.safeParse({
      ...normalized.draft,
      commandId: VALIDATION_COMMAND_ID,
      expectedSchemaRevisionNo: 1,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? messages["visual.reviewFields"]);
      return;
    }
    setError(null);
    onSubmit(normalized.draft);
  };

  return (
    <section className="mt-4 rounded-xl border border-cyan-400/30 bg-slate-950/70 p-4">
      <h3 id={headingId} className="font-semibold text-white">
        {formLabel}
      </h3>
      <p className="mt-1 text-xs text-slate-400">{messages["visual.formDescription"]}</p>
      <form
        ref={formRef}
        className="mt-4 space-y-4"
        aria-labelledby={headingId}
        aria-describedby={error ? errorId : undefined}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!destructive) submit();
        }}
        onKeyDown={(event) => {
          if (!submitOnModEnter || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
            return;
          }
          event.preventDefault();
          if (!disabled && !destructive) submit();
        }}
      >
        <DraftFields
          draft={draft}
          graph={graph}
          typeSuggestions={typeSuggestions}
          onChange={(nextDraft) => {
            setDraft(nextDraft);
            setError(null);
          }}
        />
        {error ? (
          <p
            id={errorId}
            ref={errorRef}
            className="rounded-lg border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-100"
            role="alert"
            tabIndex={-1}
          >
            {error}
          </p>
        ) : null}
        {structuralBlockers.length > 0 ? (
          <div
            className="rounded-lg border border-amber-400/40 bg-amber-950/40 p-3 text-sm text-amber-100"
            role="alert"
          >
            <p className="font-semibold">{messages["visual.resolveDependencies"]}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {structuralBlockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button className={secondaryButtonClass} type="button" onClick={onCancel}>
            {messages["action.cancel"]}
          </button>
          {destructive ? (
            <DeleteConfirmation
              label={formLabel}
              description={deleteDescription(graph, draft, messages)}
              disabled={disabled || structuralBlockers.length > 0}
              onConfirm={submit}
            />
          ) : (
            <button className={primaryButtonClass} type="submit" disabled={disabled}>
              {messages["visual.applyCommand"]}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function DraftFields({
  draft,
  graph,
  typeSuggestions,
  onChange,
}: {
  readonly draft: VisualCommandDraft;
  readonly graph: SchemaGraph;
  readonly typeSuggestions: readonly string[];
  readonly onChange: (draft: VisualCommandDraft) => void;
}) {
  const { messages } = useUiLocale();
  switch (draft.kind) {
    case "CREATE_TABLE":
      return (
        <>
          <TextField
            label={messages["visual.field.schemaName"]}
            value={draft.table.schemaName}
            onChange={(schemaName) => onChange({ ...draft, table: { ...draft.table, schemaName } })}
          />
          <TextField
            label={messages["visual.field.tableName"]}
            value={draft.table.name}
            onChange={(name) => onChange({ ...draft, table: { ...draft.table, name } })}
          />
          <NullableTextField
            label={messages["visual.field.tableNote"]}
            multiline
            value={draft.table.note}
            onChange={(note) => onChange({ ...draft, table: { ...draft.table, note } })}
          />
          <NullableTextField
            label={messages["visual.field.tableColor"]}
            placeholder="#1f2937"
            value={draft.table.color}
            onChange={(color) => onChange({ ...draft, table: { ...draft.table, color } })}
          />
          <fieldset className={fieldsetClass}>
            <legend className={legendClass}>{messages["visual.field.initialColumn"]}</legend>
            <TextField
              label={messages["visual.field.columnName"]}
              value={draft.table.columns[0]?.name ?? ""}
              onChange={(name) =>
                onChange({
                  ...draft,
                  table: {
                    ...draft.table,
                    columns: [{ ...(draft.table.columns[0] ?? emptyColumn()), name }],
                  },
                })
              }
            />
            <ColumnValueFields
              value={draft.table.columns[0] ?? emptyColumn()}
              typeSuggestions={typeSuggestions}
              onChange={(column) =>
                onChange({ ...draft, table: { ...draft.table, columns: [column] } })
              }
            />
          </fieldset>
        </>
      );
    case "UPDATE_TABLE":
      return (
        <>
          <NullableTextField
            label={messages["visual.field.tableNote"]}
            multiline
            value={draft.changes.note ?? null}
            onChange={(note) => onChange({ ...draft, changes: { ...draft.changes, note } })}
          />
          <NullableTextField
            label={messages["visual.field.tableColor"]}
            placeholder="#1f2937"
            value={draft.changes.color ?? null}
            onChange={(color) => onChange({ ...draft, changes: { ...draft.changes, color } })}
          />
        </>
      );
    case "RENAME_TABLE":
      return (
        <TextField
          label={messages["visual.field.newTableName"]}
          value={draft.newName}
          onChange={(newName) => onChange({ ...draft, newName })}
        />
      );
    case "DELETE_TABLE":
    case "DELETE_COLUMN":
    case "DELETE_REFERENCE":
    case "DELETE_INDEX":
    case "DELETE_CHECK":
      return <p className="text-sm text-amber-100">{messages["visual.removesCanonical"]}</p>;
    case "CREATE_COLUMN":
      return (
        <>
          <TextField
            label={messages["visual.field.columnName"]}
            value={draft.column.name}
            onChange={(name) => onChange({ ...draft, column: { ...draft.column, name } })}
          />
          <ColumnValueFields
            value={draft.column}
            typeSuggestions={typeSuggestions}
            onChange={(column) => onChange({ ...draft, column })}
          />
        </>
      );
    case "ALTER_COLUMN": {
      const table = graph.tables.find((candidate) => candidate.key === draft.targetTableKey);
      const column = table?.columns.find((candidate) => candidate.key === draft.targetColumnKey);
      const current = column
        ? {
            name: column.name,
            type: column.type.display,
            primaryKey: column.primaryKey,
            unique: column.unique,
            notNull: column.notNull,
            default: column.default,
            increment: column.increment,
            note: column.note?.value ?? null,
          }
        : emptyColumn();
      return (
        <>
          <TextField
            label={messages["visual.field.columnName"]}
            value={draft.newName ?? current.name}
            onChange={(newName) => onChange({ ...draft, newName })}
          />
          <ColumnValueFields
            value={{
              name: draft.newName ?? current.name,
              type: draft.changes?.type ?? current.type,
              primaryKey: draft.changes?.primaryKey ?? current.primaryKey,
              unique: draft.changes?.unique ?? current.unique,
              notNull: draft.changes?.notNull ?? current.notNull,
              default:
                draft.changes?.default === undefined ? current.default : draft.changes.default,
              increment: draft.changes?.increment ?? current.increment,
              note: draft.changes?.note === undefined ? current.note : draft.changes.note,
            }}
            typeSuggestions={typeSuggestions}
            onChange={(value) => {
              const { name: newName, ...changes } = value;
              onChange({ ...draft, newName, changes });
            }}
          />
          <label className={labelClass}>
            {messages["visual.field.moveBefore"]}
            <select
              className={inputClass}
              value={draft.beforeColumnKey ?? ""}
              onChange={(event) =>
                onChange({ ...draft, beforeColumnKey: event.target.value || null })
              }
            >
              <option value="">{messages["visual.field.endOfColumns"]}</option>
              {table?.columns
                .filter(
                  (candidate) => candidate.key !== draft.targetColumnKey && !candidate.injectedFrom,
                )
                .map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.name}
                  </option>
                ))}
            </select>
          </label>
        </>
      );
    }
    case "CREATE_REFERENCE":
      return (
        <>
          <TextField
            label={messages["visual.field.referenceSchema"]}
            value={draft.reference.schemaName}
            onChange={(schemaName) =>
              onChange({ ...draft, reference: { ...draft.reference, schemaName } })
            }
          />
          <ReferenceFields
            graph={graph}
            value={draft.reference}
            onChange={(reference) =>
              onChange({ ...draft, reference: { ...draft.reference, ...reference } })
            }
          />
        </>
      );
    case "UPDATE_REFERENCE":
      return (
        <ReferenceFields
          graph={graph}
          value={{
            name: draft.changes.name ?? null,
            endpoints: draft.changes.endpoints ?? fallbackEndpoints(graph),
            onDelete: draft.changes.onDelete ?? null,
            onUpdate: draft.changes.onUpdate ?? null,
            color: draft.changes.color ?? null,
            inactive: draft.changes.inactive ?? false,
          }}
          onChange={(changes) => onChange({ ...draft, changes })}
        />
      );
    case "CREATE_INDEX":
      return (
        <IndexFields
          table={graph.tables.find((table) => table.key === draft.targetTableKey) ?? null}
          value={draft.index}
          onChange={(index) => onChange({ ...draft, index })}
        />
      );
    case "UPDATE_INDEX":
      return (
        <IndexFields
          table={graph.tables.find((table) => table.key === draft.targetTableKey) ?? null}
          value={{
            name: draft.changes.name ?? null,
            terms: draft.changes.terms ?? [],
            type: draft.changes.type ?? null,
            unique: draft.changes.unique ?? false,
            primaryKey: draft.changes.primaryKey ?? false,
            note: draft.changes.note ?? null,
          }}
          onChange={(changes) => onChange({ ...draft, changes })}
        />
      );
    case "CREATE_CHECK":
      return (
        <CheckFields
          columnOwned={draft.ownerColumnKey !== null}
          value={draft.check}
          onChange={(check) => onChange({ ...draft, check })}
        />
      );
    case "UPDATE_CHECK":
      return (
        <CheckFields
          columnOwned={draft.ownerColumnKey !== null}
          value={{
            name: draft.changes.name ?? null,
            expression: draft.changes.expression ?? "",
          }}
          onChange={(changes) => onChange({ ...draft, changes })}
        />
      );
    case "UPDATE_GROUP_MEMBERSHIP": {
      const group = graph.groups.find((candidate) => candidate.key === draft.targetGroupKey);
      const baseline = new Set(group?.tableKeys ?? []);
      const selected = new Set([
        ...[...baseline].filter((key) => !draft.removeTableKeys.includes(key)),
        ...draft.addTableKeys,
      ]);
      return (
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>{messages["visual.field.groupMembers"]}</legend>
          <CheckboxList
            values={graph.tables.map((table) => ({ key: table.key, label: qualifiedTable(table) }))}
            selected={selected}
            onChange={(next) =>
              onChange({
                ...draft,
                addTableKeys: [...next].filter((key) => !baseline.has(key)),
                removeTableKeys: [...baseline].filter((key) => !next.has(key)),
              })
            }
          />
        </fieldset>
      );
    }
    case "UPDATE_DIAGRAM_VIEW":
      return (
        <>
          <FilterEditor
            label={messages["visual.field.tableVisibility"]}
            values={graph.tables.map((table) => ({ key: table.key, label: qualifiedTable(table) }))}
            value={draft.changes.visibleTableKeys ?? null}
            onChange={(visibleTableKeys) =>
              onChange({ ...draft, changes: { ...draft.changes, visibleTableKeys } })
            }
          />
          <FilterEditor
            label={messages["visual.field.noteVisibility"]}
            values={graph.notes.map((note) => ({ key: note.key, label: note.name }))}
            value={draft.changes.visibleNoteKeys ?? null}
            onChange={(visibleNoteKeys) =>
              onChange({ ...draft, changes: { ...draft.changes, visibleNoteKeys } })
            }
          />
          <FilterEditor
            label={messages["visual.field.groupVisibility"]}
            values={graph.groups.map((group) => ({
              key: group.key,
              label: `${group.schemaName}.${group.name}`,
            }))}
            value={draft.changes.visibleGroupKeys ?? null}
            onChange={(visibleGroupKeys) =>
              onChange({ ...draft, changes: { ...draft.changes, visibleGroupKeys } })
            }
          />
          <FilterEditor
            label={messages["visual.field.schemaVisibility"]}
            values={[...new Set(graph.tables.map((table) => table.schemaName))]
              .sort(compareCodeUnits)
              .map((name) => ({ key: name, label: name }))}
            value={draft.changes.visibleSchemaNames ?? null}
            onChange={(visibleSchemaNames) =>
              onChange({ ...draft, changes: { ...draft.changes, visibleSchemaNames } })
            }
          />
        </>
      );
  }
}

function ColumnValueFields({
  value,
  typeSuggestions,
  onChange,
}: {
  readonly value: ReturnType<typeof emptyColumn>;
  readonly typeSuggestions: readonly string[];
  readonly onChange: (value: ReturnType<typeof emptyColumn>) => void;
}) {
  const { messages } = useUiLocale();
  const typeListId = useId();
  const actual = value;
  return (
    <>
      <label className={labelClass}>
        {messages["visual.field.columnType"]}
        <input
          aria-label={messages["visual.field.columnType"]}
          className={inputClass}
          list={typeListId}
          required
          value={actual.type}
          onChange={(event) => onChange({ ...actual, type: event.target.value })}
        />
        <datalist id={typeListId}>
          {typeSuggestions.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
        <span className="text-xs font-normal text-slate-400">
          {messages["visual.field.typeSuggestion"]}
        </span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <BooleanField
          label={messages["visual.field.primaryKey"]}
          checked={actual.primaryKey}
          onChange={(primaryKey) => onChange({ ...actual, primaryKey })}
        />
        <BooleanField
          label={messages["visual.field.unique"]}
          checked={actual.unique}
          onChange={(unique) => onChange({ ...actual, unique })}
        />
        <BooleanField
          label={messages["visual.field.notNull"]}
          checked={actual.notNull}
          onChange={(notNull) => onChange({ ...actual, notNull })}
        />
        <BooleanField
          label={messages["visual.field.increment"]}
          checked={actual.increment}
          onChange={(increment) => onChange({ ...actual, increment })}
        />
      </div>
      <DefaultField
        value={actual.default}
        onChange={(nextDefault) => onChange({ ...actual, default: nextDefault })}
      />
      <NullableTextField
        label={messages["visual.field.columnNote"]}
        multiline
        value={actual.note}
        onChange={(note) => onChange({ ...actual, note })}
      />
    </>
  );
}

function DefaultField({
  value,
  onChange,
}: {
  readonly value: VisualColumnDefault | null;
  readonly onChange: (value: VisualColumnDefault | null) => void;
}) {
  const { messages } = useUiLocale();
  const kind = value?.type ?? "none";
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{messages["visual.field.columnDefault"]}</legend>
      <label className={labelClass}>
        {messages["visual.field.defaultKind"]}
        <select
          className={inputClass}
          value={kind}
          onChange={(event) => onChange(defaultForKind(event.target.value))}
        >
          <option value="none">{messages["visual.value.none"]}</option>
          <option value="number">{messages["visual.value.number"]}</option>
          <option value="string">{messages["visual.value.string"]}</option>
          <option value="boolean">{messages["visual.value.boolean"]}</option>
          <option value="expression">{messages["visual.value.expression"]}</option>
          <option value="null">{messages["visual.value.null"]}</option>
        </select>
      </label>
      {value?.type === "number" ? (
        <label className={labelClass}>
          {messages["visual.field.defaultNumber"]}
          <input
            className={inputClass}
            type="number"
            value={value.value}
            onChange={(event) => onChange({ type: "number", value: event.target.valueAsNumber })}
          />
        </label>
      ) : value?.type === "string" || value?.type === "expression" ? (
        <TextField
          label={
            value.type === "string"
              ? messages["visual.field.defaultString"]
              : messages["visual.field.defaultExpression"]
          }
          required={value.type === "expression"}
          value={value.value}
          onChange={(next) => onChange({ type: value.type, value: next })}
        />
      ) : value?.type === "boolean" ? (
        <label className={labelClass}>
          {messages["visual.field.defaultBoolean"]}
          <select
            className={inputClass}
            value={String(value.value)}
            onChange={(event) =>
              onChange({ type: "boolean", value: event.target.value === "true" })
            }
          >
            <option value="true">{messages["visual.value.true"]}</option>
            <option value="false">{messages["visual.value.false"]}</option>
          </select>
        </label>
      ) : null}
    </fieldset>
  );
}

interface ReferenceFieldValue {
  name: string | null;
  endpoints: [VisualReferenceEndpoint, VisualReferenceEndpoint];
  onDelete: "cascade" | "restrict" | "set null" | "set default" | "no action" | null;
  onUpdate: "cascade" | "restrict" | "set null" | "set default" | "no action" | null;
  color: string | null;
  inactive: boolean;
}

function ReferenceFields({
  graph,
  value,
  onChange,
}: {
  readonly graph: SchemaGraph;
  readonly value: ReferenceFieldValue;
  readonly onChange: (value: ReferenceFieldValue) => void;
}) {
  const { messages } = useUiLocale();
  return (
    <>
      <NullableTextField
        label={messages["visual.field.referenceName"]}
        value={value.name}
        onChange={(name) => onChange({ ...value, name })}
      />
      {(["source", "target"] as const).map((endpointSlot) => {
        const endpointIndex = endpointSlot === "source" ? 0 : 1;
        return (
          <EndpointEditor
            key={endpointSlot}
            label={messages["visual.field.endpoint"](endpointIndex + 1)}
            graph={graph}
            value={value.endpoints[endpointIndex]}
            onChange={(nextEndpoint) => {
              const endpoints = [...value.endpoints] as [
                VisualReferenceEndpoint,
                VisualReferenceEndpoint,
              ];
              endpoints[endpointIndex] = nextEndpoint;
              onChange({ ...value, endpoints });
            }}
          />
        );
      })}
      <div className="grid gap-3 sm:grid-cols-2">
        <ActionField
          label={messages["visual.field.onDelete"]}
          value={value.onDelete}
          onChange={(onDelete) => onChange({ ...value, onDelete })}
        />
        <ActionField
          label={messages["visual.field.onUpdate"]}
          value={value.onUpdate}
          onChange={(onUpdate) => onChange({ ...value, onUpdate })}
        />
      </div>
      <NullableTextField
        label={messages["visual.field.referenceColor"]}
        placeholder="#1f2937"
        value={value.color}
        onChange={(color) => onChange({ ...value, color })}
      />
      <BooleanField
        label={messages["visual.field.inactive"]}
        checked={value.inactive}
        onChange={(inactive) => onChange({ ...value, inactive })}
      />
    </>
  );
}

function EndpointEditor({
  label,
  graph,
  value,
  onChange,
}: {
  readonly label: string;
  readonly graph: SchemaGraph;
  readonly value: VisualReferenceEndpoint;
  readonly onChange: (value: VisualReferenceEndpoint) => void;
}) {
  const { messages } = useUiLocale();
  const table =
    graph.tables.find((candidate) => candidate.key === value.tableKey) ?? graph.tables[0];
  const columns = table?.columns.filter((column) => !column.injectedFrom) ?? [];
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{label}</legend>
      <label className={labelClass}>
        {messages["visual.field.table"]}
        <select
          className={inputClass}
          value={value.tableKey}
          onChange={(event) => {
            const nextTable = graph.tables.find(
              (candidate) => candidate.key === event.target.value,
            );
            onChange({
              ...value,
              tableKey: event.target.value,
              columnKeys: nextTable?.columns[0] ? [nextTable.columns[0].key] : [],
            });
          }}
        >
          {graph.tables.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {qualifiedTable(candidate)}
            </option>
          ))}
        </select>
      </label>
      <ol className="space-y-2" aria-label={messages["visual.field.orderedColumns"](label)}>
        {createSemanticRows(value.columnKeys, (columnKey) => columnKey).map((row) => (
          <li key={row.key} className="flex flex-wrap items-end gap-2">
            <label className={`${labelClass} min-w-48 flex-1`}>
              {messages["visual.field.columnNumber"](row.index + 1)}
              <select
                className={inputClass}
                value={row.value}
                onChange={(event) =>
                  onChange({
                    ...value,
                    columnKeys: replaceAt(value.columnKeys, row.index, event.target.value),
                  })
                }
              >
                {columns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <OrderButtons
              index={row.index}
              length={value.columnKeys.length}
              onMove={(direction) =>
                onChange({ ...value, columnKeys: move(value.columnKeys, row.index, direction) })
              }
              onRemove={() =>
                onChange({
                  ...value,
                  columnKeys: value.columnKeys.filter((_, itemIndex) => itemIndex !== row.index),
                })
              }
            />
          </li>
        ))}
      </ol>
      <button
        className={secondaryButtonClass}
        type="button"
        onClick={() =>
          columns[0] && onChange({ ...value, columnKeys: [...value.columnKeys, columns[0].key] })
        }
      >
        {messages["visual.field.addEndpointColumn"]}
      </button>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          {messages["visual.field.minimumCardinality"]}
          <select
            className={inputClass}
            value={value.multiplicity.min}
            onChange={(event) =>
              onChange({
                ...value,
                multiplicity: { ...value.multiplicity, min: Number(event.target.value) as 0 | 1 },
              })
            }
          >
            <option value={0}>{messages["visual.value.optional"]}</option>
            <option value={1}>{messages["visual.value.required"]}</option>
          </select>
        </label>
        <label className={labelClass}>
          {messages["visual.field.maximumCardinality"]}
          <select
            className={inputClass}
            value={value.multiplicity.max ?? "many"}
            onChange={(event) =>
              onChange({
                ...value,
                multiplicity: {
                  ...value.multiplicity,
                  max: event.target.value === "many" ? null : 1,
                },
              })
            }
          >
            <option value={1}>{messages["visual.value.one"]}</option>
            <option value="many">{messages["visual.value.many"]}</option>
          </select>
        </label>
      </div>
    </fieldset>
  );
}

interface IndexFieldValue {
  name: string | null;
  terms: VisualIndexTerm[];
  type: string | null;
  unique: boolean;
  primaryKey: boolean;
  note: string | null;
}

function IndexFields({
  table,
  value,
  onChange,
}: {
  readonly table: TableNode | null;
  readonly value: IndexFieldValue;
  readonly onChange: (value: IndexFieldValue) => void;
}) {
  const { messages } = useUiLocale();
  return (
    <>
      <NullableTextField
        label={messages["visual.field.indexName"]}
        value={value.name}
        onChange={(name) => onChange({ ...value, name })}
      />
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{messages["visual.field.indexTerms"]}</legend>
        <ol className="space-y-2">
          {createSemanticRows(value.terms, serializeIndexTerm).map((row) => (
            <li key={row.key} className="rounded-lg border border-slate-700 p-3">
              <label className={labelClass}>
                {messages["visual.field.termKind"]}
                <select
                  className={inputClass}
                  value={row.value.kind}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      terms: replaceAt(
                        value.terms,
                        row.index,
                        event.target.value === "COLUMN"
                          ? { kind: "COLUMN", columnKey: table?.columns[0]?.key ?? "" }
                          : { kind: "EXPRESSION", expression: "" },
                      ),
                    })
                  }
                >
                  <option value="COLUMN">{messages["visual.field.column"]}</option>
                  <option value="EXPRESSION">{messages["visual.value.expression"]}</option>
                </select>
              </label>
              {row.value.kind === "COLUMN" ? (
                <label className={labelClass}>
                  {messages["visual.field.column"]}
                  <select
                    className={inputClass}
                    value={row.value.columnKey}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        terms: replaceAt(value.terms, row.index, {
                          kind: "COLUMN",
                          columnKey: event.target.value,
                        }),
                      })
                    }
                  >
                    {table?.columns
                      .filter((column) => !column.injectedFrom)
                      .map((column) => (
                        <option key={column.key} value={column.key}>
                          {column.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <TextField
                  label={messages["visual.value.expression"]}
                  value={row.value.expression}
                  onChange={(expression) =>
                    onChange({
                      ...value,
                      terms: replaceAt(value.terms, row.index, {
                        kind: "EXPRESSION",
                        expression,
                      }),
                    })
                  }
                />
              )}
              <OrderButtons
                index={row.index}
                length={value.terms.length}
                onMove={(direction) =>
                  onChange({ ...value, terms: move(value.terms, row.index, direction) })
                }
                onRemove={() =>
                  onChange({
                    ...value,
                    terms: value.terms.filter((_, itemIndex) => itemIndex !== row.index),
                  })
                }
              />
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className={secondaryButtonClass}
            type="button"
            onClick={() =>
              table?.columns[0] &&
              onChange({
                ...value,
                terms: [...value.terms, { kind: "COLUMN", columnKey: table.columns[0].key }],
              })
            }
          >
            {messages["visual.field.addColumnTerm"]}
          </button>
          <button
            className={secondaryButtonClass}
            type="button"
            onClick={() =>
              onChange({
                ...value,
                terms: [...value.terms, { kind: "EXPRESSION", expression: "lower(value)" }],
              })
            }
          >
            {messages["visual.field.addExpressionTerm"]}
          </button>
        </div>
      </fieldset>
      <NullableTextField
        label={messages["visual.field.indexType"]}
        value={value.type}
        onChange={(type) => onChange({ ...value, type })}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <BooleanField
          label={messages["visual.field.uniqueIndex"]}
          checked={value.unique}
          onChange={(unique) => onChange({ ...value, unique })}
        />
        <BooleanField
          label={messages["visual.field.primaryIndex"]}
          checked={value.primaryKey}
          onChange={(primaryKey) => onChange({ ...value, primaryKey })}
        />
      </div>
      <NullableTextField
        label={messages["visual.field.indexNote"]}
        multiline
        value={value.note}
        onChange={(note) => onChange({ ...value, note })}
      />
    </>
  );
}

interface CheckFieldValue {
  name: string | null;
  expression: string;
}

function CheckFields({
  columnOwned,
  value,
  onChange,
}: {
  readonly columnOwned: boolean;
  readonly value: CheckFieldValue;
  readonly onChange: (value: CheckFieldValue) => void;
}) {
  const { messages } = useUiLocale();
  return (
    <>
      <label className={labelClass}>
        {messages["visual.field.checkName"]}
        <input
          className={inputClass}
          disabled={columnOwned}
          placeholder={
            columnOwned
              ? messages["visual.field.columnChecksUnnamed"]
              : messages["visual.field.optional"]
          }
          value={value.name ?? ""}
          onChange={(event) => onChange({ ...value, name: event.target.value || null })}
        />
      </label>
      <TextField
        label={messages["visual.field.checkExpression"]}
        value={value.expression}
        onChange={(expression) => onChange({ ...value, expression })}
      />
    </>
  );
}

function FilterEditor({
  label,
  values,
  value,
  onChange,
}: {
  readonly label: string;
  readonly values: readonly { key: string; label: string }[];
  readonly value: string[] | null;
  readonly onChange: (value: string[] | null) => void;
}) {
  const { messages } = useUiLocale();
  const mode = value === null ? "NONE" : value.length === 0 ? "ALL" : "SELECTED";
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{label}</legend>
      <div className="flex flex-wrap gap-3">
        {(["ALL", "SELECTED", "NONE"] as const).map((candidate) => (
          <label key={candidate} className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="radio"
              name={`${label}-mode`}
              checked={mode === candidate}
              onChange={() =>
                onChange(
                  candidate === "NONE"
                    ? null
                    : candidate === "SELECTED" && values[0]
                      ? [values[0].key]
                      : [],
                )
              }
            />
            {candidate === "ALL"
              ? messages["visual.value.all"]
              : candidate === "NONE"
                ? messages["visual.value.none"]
                : messages["visual.value.selected"]}
          </label>
        ))}
      </div>
      {mode === "SELECTED" ? (
        <CheckboxList
          values={values}
          selected={new Set(value ?? [])}
          onChange={(selected) => onChange([...selected])}
        />
      ) : null}
    </fieldset>
  );
}

function CheckboxList({
  values,
  selected,
  onChange,
}: {
  readonly values: readonly { key: string; label: string }[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: Set<string>) => void;
}) {
  return (
    <div className="mt-3 max-h-48 space-y-2 overflow-auto">
      {values.map((value) => (
        <label key={value.key} className="flex min-h-9 items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={selected.has(value.key)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(value.key);
              else next.delete(value.key);
              onChange(next);
            }}
          />
          <span>{value.label}</span>
        </label>
      ))}
    </div>
  );
}

function OrderButtons({
  index,
  length,
  onMove,
  onRemove,
}: {
  readonly index: number;
  readonly length: number;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { messages } = useUiLocale();
  return (
    <div className="flex gap-1">
      <button
        className={smallButtonClass}
        type="button"
        disabled={index === 0}
        aria-label={messages["visual.moveUp"](index + 1)}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        className={smallButtonClass}
        type="button"
        disabled={index === length - 1}
        aria-label={messages["visual.moveDown"](index + 1)}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <button
        className={smallButtonClass}
        type="button"
        disabled={length === 1}
        aria-label={messages["visual.removeItem"](index + 1)}
        onClick={onRemove}
      >
        {messages["visual.remove"]}
      </button>
    </div>
  );
}

type ReferenceActionValue =
  | "cascade"
  | "restrict"
  | "set null"
  | "set default"
  | "no action"
  | null;

function ActionField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: ReferenceActionValue;
  readonly onChange: (value: ReferenceActionValue) => void;
}) {
  const { messages } = useUiLocale();
  return (
    <label className={labelClass}>
      {label}
      <select
        className={inputClass}
        value={value ?? ""}
        onChange={(event) => onChange((event.target.value || null) as typeof value)}
      >
        <option value="">{messages["visual.value.none"]}</option>
        <option value="cascade">{messages["visual.action.cascade"]}</option>
        <option value="restrict">{messages["visual.action.restrict"]}</option>
        <option value="set null">{messages["visual.action.setNull"]}</option>
        <option value="set default">{messages["visual.action.setDefault"]}</option>
        <option value="no action">{messages["visual.action.noAction"]}</option>
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  required = true,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly required?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        className={inputClass}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NullableTextField({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly multiline?: boolean;
  readonly placeholder?: string;
}) {
  const inputId = useId();
  const props = {
    id: inputId,
    className: inputClass,
    value: value ?? "",
    placeholder,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value || null),
  };
  return (
    <div className={labelClass}>
      <label htmlFor={inputId}>{label}</label>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} />}
    </div>
  );
}

function BooleanField({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function DeleteConfirmation({
  label,
  description,
  disabled,
  onConfirm,
}: {
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}) {
  const { messages } = useUiLocale();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className={dangerButtonClass} type="button" disabled={disabled}>
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/80" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-red-400/40 bg-slate-900 p-6 shadow-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButtonRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold text-white">
            {messages["visual.confirmAction"](label)}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm text-slate-300">
            {description}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button ref={cancelButtonRef} className={secondaryButtonClass} type="button">
                {messages["action.cancel"]}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button className={dangerButtonClass} type="button" onClick={onConfirm}>
                {messages["visual.confirmDelete"]}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function createSemanticRows<T>(
  values: readonly T[],
  serialize: (value: T) => string,
): Array<{ key: string; value: T; index: number }> {
  const occurrences = new Map<string, number>();
  return values.map((value, index) => {
    const semanticKey = serialize(value);
    const occurrence = occurrences.get(semanticKey) ?? 0;
    occurrences.set(semanticKey, occurrence + 1);
    return { key: `${semanticKey}:${occurrence}`, value, index };
  });
}

function serializeIndexTerm(term: VisualIndexTerm): string {
  return term.kind === "COLUMN" ? `column:${term.columnKey}` : `expression:${term.expression}`;
}

function deleteDescription(
  graph: SchemaGraph,
  draft: VisualCommandDraft,
  messages: UiMessages,
): string {
  if (draft.kind === "DELETE_TABLE") {
    const table = graph.tables.find((candidate) => candidate.key === draft.targetTableKey);
    const references = graph.references.filter((reference) =>
      reference.endpoints.some((endpoint) => endpoint.tableKey === draft.targetTableKey),
    ).length;
    const checks =
      (table?.checks.length ?? 0) +
      (table?.columns.reduce((count, column) => count + column.checks.length, 0) ?? 0);
    return messages["visual.deleteTableDescription"](
      table ? qualifiedTable(table) : messages["visual.thisTable"],
      table?.columns.length ?? 0,
      table?.indexes.length ?? 0,
      checks,
      references,
    );
  }
  if (draft.kind === "DELETE_COLUMN") {
    const resolved = findColumn(graph, draft.targetColumnKey);
    const references = graph.references.filter((reference) =>
      reference.endpoints.some((endpoint) => endpoint.columnKeys.includes(draft.targetColumnKey)),
    ).length;
    return messages["visual.deleteColumnDescription"](
      resolved?.column.name ?? messages["visual.thisColumn"],
      resolved?.column.checks.length ?? 0,
      references,
    );
  }
  return messages["visual.deleteGenericDescription"];
}

function deleteStructuralBlockers(
  graph: SchemaGraph,
  draft: VisualCommandDraft,
  messages: UiMessages,
): string[] {
  if (draft.kind === "DELETE_TABLE") {
    const referenceCount = graph.references.filter((reference) =>
      reference.endpoints.some((endpoint) => endpoint.tableKey === draft.targetTableKey),
    ).length;
    const groupCount = graph.groups.filter((group) =>
      group.tableKeys.includes(draft.targetTableKey),
    ).length;
    const viewCount = graph.views.filter((view) =>
      view.visibleTableKeys?.includes(draft.targetTableKey),
    ).length;
    return [
      ...(referenceCount > 0 ? [messages["visual.referenceDependencies"](referenceCount)] : []),
      ...(groupCount > 0 ? [messages["visual.groupDependencies"](groupCount)] : []),
      ...(viewCount > 0 ? [messages["visual.viewDependencies"](viewCount)] : []),
    ];
  }
  if (draft.kind === "DELETE_COLUMN") {
    const resolved = findColumn(graph, draft.targetColumnKey);
    const referenceCount = graph.references.filter((reference) =>
      reference.endpoints.some((endpoint) => endpoint.columnKeys.includes(draft.targetColumnKey)),
    ).length;
    const indexCount =
      resolved?.table.indexes.filter((index) =>
        index.terms.some(
          (term) => term.kind === "COLUMN" && term.columnKey === draft.targetColumnKey,
        ),
      ).length ?? 0;
    return [
      ...(referenceCount > 0 ? [messages["visual.referenceDependencies"](referenceCount)] : []),
      ...(indexCount > 0 ? [messages["visual.indexDependencies"](indexCount)] : []),
    ];
  }
  return [];
}

function listTypeSuggestions(graph: SchemaGraph, dialect: PrimaryDialect): string[] {
  const enumNames = graph.enums.map((value) =>
    value.schemaName === "public" ? value.name : `${value.schemaName}.${value.name}`,
  );
  return [...new Set([...getSqlBuiltinTypes(dialect), ...enumNames])].sort(compareCodeUnits);
}

function fallbackEndpoints(graph: SchemaGraph): [VisualReferenceEndpoint, VisualReferenceEndpoint] {
  const table = graph.tables.find((candidate) => candidate.columns.length > 0);
  const column = table?.columns[0];
  const fallback = {
    tableKey: table?.key ?? "table:missing",
    columnKeys: column ? [column.key] : [],
    multiplicity: { min: 0 as const, max: 1 as const },
  };
  return [
    { ...fallback, columnKeys: [...fallback.columnKeys] },
    { ...fallback, columnKeys: [...fallback.columnKeys] },
  ];
}

function defaultForKind(kind: string): VisualColumnDefault | null {
  if (kind === "number") return { type: "number", value: 0 };
  if (kind === "string") return { type: "string", value: "" };
  if (kind === "boolean") return { type: "boolean", value: true };
  if (kind === "expression") return { type: "expression", value: "now()" };
  if (kind === "null") return { type: "null", value: null };
  return null;
}

function emptyColumn() {
  return { name: "id", ...columnDefaults() };
}
function columnDefaults() {
  return {
    type: "integer",
    primaryKey: false,
    unique: false,
    notNull: false,
    default: null as VisualColumnDefault | null,
    increment: false,
    note: null as string | null,
  };
}
function isDeleteCommand(kind: string): boolean {
  return kind.startsWith("DELETE_");
}
function qualifiedTable(table: TableNode): string {
  return `${table.schemaName}.${table.name}`;
}
function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}
function move<T>(values: readonly T[], index: number, direction: -1 | 1): T[] {
  const next = [...values];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const labelClass = "grid gap-1.5 text-sm font-semibold text-slate-200";
const inputClass = "ui-input";
const fieldsetClass = "space-y-3 rounded-xl border border-slate-700 p-3";
const legendClass = "px-1 text-sm font-semibold text-cyan-100";
const primaryButtonClass = "ui-button ui-button--primary";
const secondaryButtonClass = "ui-button";
const dangerButtonClass = "ui-button ui-button--danger";
const smallButtonClass = "ui-button ui-button--compact";
