import { type PrimaryDialect, type ProjectSummary, utf8ByteLength } from "@er-diagram/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ProjectApiError } from "./project-api.js";
import { useProjectApi } from "./project-api-context.js";
import { projectQueryKeys } from "./project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";

const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-cyan-300 px-4 font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-55";
const secondaryButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-3 font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-55";
const dangerButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg border border-red-400/60 bg-red-950/40 px-3 font-semibold text-red-100 transition hover:bg-red-900/60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-300 disabled:cursor-not-allowed disabled:opacity-55";
const inputClass =
  "min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-slate-100 placeholder:text-slate-400 focus:border-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-300";

export function ProjectHomePage() {
  const api = useProjectApi();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const projectsQuery = useQuery({
    queryKey: projectQueryKeys.list,
    queryFn: () => api.listProjects(),
  });

  return (
    <section aria-labelledby="projects-heading">
      <div className="flex flex-col gap-5 border-b border-slate-800 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
            Schema projects
          </p>
          <h1
            ref={headingRef}
            id="projects-heading"
            className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl"
            tabIndex={-1}
          >
            Projects
          </h1>
          <p className="mt-3 max-w-2xl text-slate-300">
            Keep canonical DBML, validation state, and revision history in this self-hosted
            workspace.
          </p>
        </div>
        <CreateProjectDialog />
      </div>

      <ImportAvailability />

      {projectsQuery.isPending ? (
        <p
          className="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-300"
          aria-live="polite"
        >
          Loading projects…
        </p>
      ) : projectsQuery.isError ? (
        <section
          className="mt-8 rounded-xl border border-red-400/40 bg-red-950/30 p-5"
          role="alert"
        >
          <h2 className="font-semibold text-red-100">Projects could not be loaded</h2>
          <p className="mt-2 text-sm text-red-100/80">
            The server did not return a usable project list. No project data was changed.
          </p>
          <button
            className={`${secondaryButtonClass} mt-4`}
            type="button"
            onClick={() => void projectsQuery.refetch()}
          >
            Try again
          </button>
        </section>
      ) : projectsQuery.data.projects.length === 0 ? (
        <section className="mt-8 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
          <h2 className="text-xl font-semibold text-white">No projects yet</h2>
          <p className="mx-auto mt-3 max-w-lg text-slate-300">
            Create an empty PostgreSQL or MySQL project, or start from a local DBML text file.
          </p>
        </section>
      ) : (
        <ul className="mt-8 grid gap-5 lg:grid-cols-2">
          {projectsQuery.data.projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} focusAfterDeleteRef={headingRef} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ImportAvailability() {
  return (
    <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-labelledby="import-options-heading">
      <h2 id="import-options-heading" className="sr-only">
        Project input options
      </h2>
      <AvailabilityCard
        title="DBML file"
        status="Available"
        detail="Create a project from local DBML text."
      />
      <AvailabilityCard
        title="SQL DDL"
        status="Available"
        detail="Preview PostgreSQL or MySQL DDL without execution."
        to="/sql-import/new"
      />
      <AvailabilityCard
        title="Portable bundle"
        status="Available"
        detail="Create a new project from a validated portable ZIP."
        to="/project-bundles/import"
        actionLabel="Import bundle"
      />
    </section>
  );
}

function AvailabilityCard({
  title,
  status,
  detail,
  to,
  actionLabel,
}: {
  readonly title: string;
  readonly status: string;
  readonly detail: string;
  readonly to?: string;
  readonly actionLabel?: string;
}) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-white">{title}</h3>
        <span className="text-xs font-semibold text-cyan-300">{status}</span>
      </div>
      <p className="mt-2 text-sm text-slate-400">{detail}</p>
      {to ? (
        <Link className={`${secondaryButtonClass} mt-4`} to={to}>
          {actionLabel ?? "Start SQL import"}
        </Link>
      ) : null}
    </article>
  );
}

function ProjectCard({
  project,
  focusAfterDeleteRef,
}: {
  readonly project: ProjectSummary;
  readonly focusAfterDeleteRef: RefObject<HTMLElement | null>;
}) {
  return (
    <article
      className="h-full rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl shadow-black/10"
      aria-label={project.name}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
            {dialectLabel(project.primaryDialect)}
          </p>
          <h2 className="mt-2 truncate text-xl font-semibold text-white">{project.name}</h2>
        </div>
        <ValidityBadge validity={project.draftValidity} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <Metadata label="Parser" value={project.parserVersion} />
        <Metadata label="Revision" value={String(project.schemaRevisionNo)} />
      </dl>
      <p className="mt-4 text-sm text-slate-300">
        {diagnosticSummaryLabel(project.diagnosticSummary)}
      </p>
      <p className="mt-2 text-xs text-slate-400">
        Updated <time dateTime={project.updatedAt}>{formatTimestamp(project.updatedAt)}</time>
      </p>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        <Link
          className={primaryButtonClass}
          aria-label={`Open ${project.name}`}
          to={`/projects/${project.id}`}
        >
          Open
        </Link>
        <RenameProjectDialog project={project} />
        <DuplicateProjectDialog project={project} />
        <DeleteProjectDialog project={project} focusAfterDeleteRef={focusAfterDeleteRef} />
      </div>
    </article>
  );
}

function Metadata({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg bg-slate-950/70 p-3">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-1 font-semibold text-slate-200">
        {label === "Parser" ? `Parser ${value}` : `Revision ${value}`}
      </dd>
    </div>
  );
}

export function ValidityBadge({ validity }: { readonly validity: "VALID" | "INVALID" }) {
  const valid = validity === "VALID";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold ${
        valid
          ? "border-emerald-400/40 bg-emerald-950/50 text-emerald-200"
          : "border-amber-400/50 bg-amber-950/50 text-amber-100"
      }`}
    >
      <span aria-hidden="true">{valid ? "✓" : "!"}</span>
      {valid ? "Draft valid" : "Draft invalid"}
    </span>
  );
}

function CreateProjectDialog() {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const runtimeLimits = useRuntimeResourceLimits();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dialect, setDialect] = useState<PrimaryDialect>("POSTGRESQL");
  const [sourceMode, setSourceMode] = useState<"EMPTY" | "DBML_FILE">("EMPTY");
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [formError, setFormError] = useState<unknown>();
  const [readingFile, setReadingFile] = useState(false);
  const fileReadSequence = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: (input: {
      readonly name: string;
      readonly dialect: PrimaryDialect;
      readonly source: string;
    }) =>
      api.createProject({ name: input.name, primaryDialect: input.dialect, source: input.source }),
    retry: false,
  });

  function resetForm() {
    setName("");
    setDialect("POSTGRESQL");
    setSourceMode("EMPTY");
    setSource("");
    setFileName(undefined);
    setFileError(undefined);
    setFormError(undefined);
    setReadingFile(false);
    fileReadSequence.current += 1;
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && mutation.isPending) return;
    if (nextOpen) resetForm();
    setOpen(nextOpen);
  }

  async function handleFile(file: File | undefined) {
    const sequence = fileReadSequence.current + 1;
    fileReadSequence.current = sequence;
    setFileName(undefined);
    setFileError(undefined);
    setSource("");
    if (!file) return;
    if (file.size > runtimeLimits.maxSourceBytes) {
      setFileError(
        `The DBML file exceeds the configured ${runtimeLimits.maxSourceBytes} byte limit.`,
      );
      return;
    }
    setReadingFile(true);
    try {
      const text = await file.text();
      if (fileReadSequence.current !== sequence) return;
      if (utf8ByteLength(text) > runtimeLimits.maxSourceBytes) {
        setFileError(
          `The DBML file exceeds the configured ${runtimeLimits.maxSourceBytes} byte limit.`,
        );
        return;
      }
      setSource(text);
      setFileName(file.name);
    } catch {
      if (fileReadSequence.current !== sequence) return;
      setFileError("The DBML file could not be read.");
    } finally {
      if (fileReadSequence.current === sequence) setReadingFile(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(new Error("Enter a project name."));
      nameInputRef.current?.focus();
      return;
    }
    if (sourceMode === "DBML_FILE" && !fileName) {
      setFormError(new Error("Choose a DBML file before creating the project."));
      return;
    }

    try {
      const result = await mutation.mutateAsync({
        name: trimmedName,
        dialect,
        source: sourceMode === "EMPTY" ? "" : source,
      });
      queryClient.setQueryData(projectQueryKeys.detail(result.state.project.id), {
        state: result.state,
      });
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      setOpen(false);
      await navigate(`/projects/${result.state.project.id}`);
    } catch (error) {
      setFormError(error);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button className={primaryButtonClass} type="button">
          New project
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title="Create project"
        description="Choose the canonical dialect and an initial DBML source. SQL is not executed."
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField ref={nameInputRef} label="Project name" value={name} onChange={setName} />
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            Primary dialect
            <select
              className={inputClass}
              value={dialect}
              onChange={(event) => setDialect(event.target.value as PrimaryDialect)}
            >
              <option value="POSTGRESQL">PostgreSQL</option>
              <option value="MYSQL">MySQL</option>
            </select>
          </label>
          <fieldset className="grid gap-3">
            <legend className="text-sm font-semibold text-slate-200">Start from</legend>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-700 px-3 text-sm">
              <input
                type="radio"
                name="source-mode"
                value="EMPTY"
                checked={sourceMode === "EMPTY"}
                onChange={() => setSourceMode("EMPTY")}
              />
              Empty DBML
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-700 px-3 text-sm">
              <input
                type="radio"
                name="source-mode"
                value="DBML_FILE"
                checked={sourceMode === "DBML_FILE"}
                onChange={() => setSourceMode("DBML_FILE")}
              />
              DBML file
            </label>
          </fieldset>
          {sourceMode === "DBML_FILE" ? (
            <label className="grid gap-2 text-sm font-semibold text-slate-200">
              Choose DBML file
              <input
                className={`${inputClass} py-2 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-1 file:text-slate-100`}
                type="file"
                accept=".dbml,text/plain"
                onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
              />
              {readingFile ? <span className="text-xs text-slate-400">Reading file…</span> : null}
              {fileName ? <span className="text-xs text-cyan-300">{fileName}</span> : null}
              {fileError ? <span className="text-xs text-red-200">{fileError}</span> : null}
            </label>
          ) : null}
          <MutationError error={formError} />
          <DialogActions
            submitLabel="Create project"
            pendingLabel="Creating…"
            pending={mutation.isPending || readingFile}
          />
        </form>
      </ProjectDialogContent>
    </Dialog.Root>
  );
}

function RenameProjectDialog({ project }: { readonly project: ProjectSummary }) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [formError, setFormError] = useState<unknown>();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: (nextName: string) =>
      api.renameProject({
        projectId: project.id,
        name: nextName,
        expectedSchemaRevisionNo: project.schemaRevisionNo,
      }),
    retry: false,
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && mutation.isPending) return;
    if (nextOpen) {
      setName(project.name);
      setFormError(undefined);
    }
    setOpen(nextOpen);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(new Error("Enter a project name."));
      nameInputRef.current?.focus();
      return;
    }
    try {
      const result = await mutation.mutateAsync(trimmedName);
      queryClient.setQueryData(projectQueryKeys.detail(project.id), result);
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      setOpen(false);
    } catch (error) {
      setFormError(error);
      await refreshAfterConflict(queryClient, error);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          className={secondaryButtonClass}
          type="button"
          aria-label={`Rename ${project.name}`}
        >
          Rename
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title="Rename project"
        description="Renaming does not create a schema revision."
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField ref={nameInputRef} label="Project name" value={name} onChange={setName} />
          <MutationError error={formError} />
          <DialogActions
            submitLabel="Save name"
            pendingLabel="Saving…"
            pending={mutation.isPending}
          />
        </form>
      </ProjectDialogContent>
    </Dialog.Root>
  );
}

function DuplicateProjectDialog({ project }: { readonly project: ProjectSummary }) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${project.name} copy`);
  const [formError, setFormError] = useState<unknown>();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: (nextName: string) =>
      api.duplicateProject({
        sourceProjectId: project.id,
        name: nextName,
        expectedSchemaRevisionNo: project.schemaRevisionNo,
      }),
    retry: false,
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && mutation.isPending) return;
    if (nextOpen) {
      setName(`${project.name} copy`);
      setFormError(undefined);
    }
    setOpen(nextOpen);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(new Error("Enter a project name."));
      nameInputRef.current?.focus();
      return;
    }
    try {
      const result = await mutation.mutateAsync(trimmedName);
      queryClient.setQueryData(projectQueryKeys.detail(result.state.project.id), {
        state: result.state,
      });
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      setOpen(false);
      await navigate(`/projects/${result.state.project.id}`);
    } catch (error) {
      setFormError(error);
      await refreshAfterConflict(queryClient, error);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          className={secondaryButtonClass}
          type="button"
          aria-label={`Duplicate ${project.name}`}
        >
          Duplicate
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title="Duplicate project"
        description="Only the current draft and last-valid state are rebased into the new project."
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField ref={nameInputRef} label="Project name" value={name} onChange={setName} />
          <MutationError error={formError} />
          <DialogActions
            submitLabel="Duplicate project"
            pendingLabel="Duplicating…"
            pending={mutation.isPending}
          />
        </form>
      </ProjectDialogContent>
    </Dialog.Root>
  );
}

function DeleteProjectDialog({
  project,
  focusAfterDeleteRef,
}: {
  readonly project: ProjectSummary;
  readonly focusAfterDeleteRef: RefObject<HTMLElement | null>;
}) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api.deleteProject({
        projectId: project.id,
        expectedSchemaRevisionNo: project.schemaRevisionNo,
      }),
    retry: false,
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && mutation.isPending) return;
    if (nextOpen) setFormError(undefined);
    setOpen(nextOpen);
  }

  async function handleDelete() {
    setFormError(undefined);
    try {
      await mutation.mutateAsync();
      queryClient.removeQueries({ queryKey: projectQueryKeys.detail(project.id) });
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      setOpen(false);
      queueMicrotask(() => focusAfterDeleteRef.current?.focus());
    } catch (error) {
      setFormError(error);
      await refreshAfterConflict(queryClient, error);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button className={dangerButtonClass} type="button" aria-label={`Delete ${project.name}`}>
          Delete
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title={`Delete ${project.name}?`}
        description="This destructive action removes the project records from the mounted application volume."
        initialFocusRef={cancelRef}
      >
        <div className="mt-5 rounded-lg border border-amber-400/40 bg-amber-950/40 p-4 text-sm text-amber-100">
          Existing external backups may still contain a copy. Portable project export is not
          available, so cancel and export a portable bundle if you need to preserve this project
          first.
        </div>
        <MutationError error={formError} />
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Dialog.Close asChild>
            <button
              ref={cancelRef}
              className={secondaryButtonClass}
              type="button"
              disabled={mutation.isPending}
            >
              Cancel
            </button>
          </Dialog.Close>
          <button
            className={dangerButtonClass}
            type="button"
            disabled={mutation.isPending}
            onClick={() => void handleDelete()}
          >
            {mutation.isPending ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </ProjectDialogContent>
    </Dialog.Root>
  );
}

function ProjectDialogContent({
  title,
  description,
  initialFocusRef,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly initialFocusRef: RefObject<HTMLElement | null>;
  readonly children: React.ReactNode;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm" />
      <Dialog.Content
        className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl shadow-black/50 focus:outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          initialFocusRef.current?.focus();
        }}
      >
        <Dialog.Title className="text-xl font-semibold text-white">{title}</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm leading-6 text-slate-300">
          {description}
        </Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function TextField({
  ref,
  label,
  value,
  onChange,
}: {
  readonly ref: RefObject<HTMLInputElement | null>;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-slate-200">
      {label}
      <input
        ref={ref}
        className={inputClass}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function DialogActions({
  submitLabel,
  pendingLabel,
  pending,
}: {
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly pending: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Dialog.Close asChild>
        <button className={secondaryButtonClass} type="button" disabled={pending}>
          Cancel
        </button>
      </Dialog.Close>
      <button className={primaryButtonClass} type="submit" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </div>
  );
}

function MutationError({ error }: { readonly error: unknown }) {
  if (!error) return null;
  const apiError = error instanceof ProjectApiError ? error : undefined;
  const conflict = apiError?.code === "PROJECT_SCHEMA_REVISION_CONFLICT";
  const localMessage = error instanceof Error && !apiError ? error.message : undefined;
  const message = conflict
    ? `This project changed in another tab${
        apiError.currentRevisionNo === undefined
          ? "."
          : `; the current revision is ${apiError.currentRevisionNo}.`
      } Review the latest state and try again.`
    : (localMessage ?? "The project could not be updated. Try again.");

  return (
    <div
      className="rounded-lg border border-red-400/40 bg-red-950/30 p-3 text-sm text-red-100"
      role="alert"
      aria-live="assertive"
    >
      <p>{message}</p>
      {apiError?.correlationId ? (
        <p className="mt-2 text-xs text-red-100/75">Correlation ID: {apiError.correlationId}</p>
      ) : null}
    </div>
  );
}

async function refreshAfterConflict(
  queryClient: ReturnType<typeof useQueryClient>,
  error: unknown,
) {
  if (error instanceof ProjectApiError && error.code === "PROJECT_SCHEMA_REVISION_CONFLICT") {
    await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
  }
}

export function diagnosticSummaryLabel(summary: ProjectSummary["diagnosticSummary"]): string {
  return `${summary.errors} ${pluralize(summary.errors, "error")} · ${summary.warnings} ${pluralize(
    summary.warnings,
    "warning",
  )} · ${summary.infos} info`;
}

export function dialectLabel(dialect: PrimaryDialect): string {
  return dialect === "POSTGRESQL" ? "PostgreSQL" : "MySQL";
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function formatTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}
