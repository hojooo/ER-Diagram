import { type PrimaryDialect, type ProjectSummary, utf8ByteLength } from "@er-diagram/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { type UiLocale, useUiLocale } from "../localization/ui-locale.js";
import { ProjectApiError } from "./project-api.js";
import { useProjectApi } from "./project-api-context.js";
import { projectQueryKeys } from "./project-queries.js";
import { useRuntimeConfig, useRuntimeResourceLimits } from "../runtime-config.js";

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
  const { messages } = useUiLocale();
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
            {messages["projects.eyebrow"]}
          </p>
          <h1
            ref={headingRef}
            id="projects-heading"
            className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl"
            tabIndex={-1}
          >
            {messages["projects.title"]}
          </h1>
          <p className="mt-3 max-w-2xl text-slate-300">{messages["projects.description"]}</p>
        </div>
        <CreateProjectDialog />
      </div>

      <ImportAvailability />
      <RuntimeReleaseDetails />

      {projectsQuery.isPending ? (
        <p
          className="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-300"
          aria-live="polite"
        >
          {messages["projects.loading"]}
        </p>
      ) : projectsQuery.isError ? (
        <section
          className="mt-8 rounded-xl border border-red-400/40 bg-red-950/30 p-5"
          role="alert"
        >
          <h2 className="font-semibold text-red-100">{messages["projects.loadErrorTitle"]}</h2>
          <p className="mt-2 text-sm text-red-100/80">{messages["projects.loadErrorMessage"]}</p>
          <button
            className={`${secondaryButtonClass} mt-4`}
            type="button"
            onClick={() => void projectsQuery.refetch()}
          >
            {messages["action.tryAgain"]}
          </button>
        </section>
      ) : projectsQuery.data.projects.length === 0 ? (
        <section className="mt-8 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
          <h2 className="text-xl font-semibold text-white">{messages["projects.emptyTitle"]}</h2>
          <p className="mx-auto mt-3 max-w-lg text-slate-300">
            {messages["projects.emptyMessage"]}
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

export function RuntimeReleaseDetails() {
  const { release } = useRuntimeConfig();
  const { messages } = useUiLocale();
  return (
    <section
      className="mt-6 rounded-xl border border-slate-800 bg-slate-950/50 p-4"
      aria-labelledby="runtime-release-heading"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="runtime-release-heading" className="font-semibold text-slate-100">
          {messages["runtime.title"]}
        </h2>
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-cyan-300">
          {release.channel === "RELEASE"
            ? messages["runtime.published"]
            : messages["runtime.development"]}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <ReleaseMetadata label={messages["runtime.imageVersion"]} value={release.version} />
        <ReleaseMetadata
          label={messages["runtime.sourceRevision"]}
          value={release.sourceRevision ?? messages["runtime.notEmbedded"]}
          code={release.sourceRevision !== null}
        />
        <ReleaseMetadata label={messages["runtime.parser"]} value={release.parserVersion} />
        <ReleaseMetadata
          label={messages["runtime.bundleSchema"]}
          value={String(release.bundleSchemaVersion)}
        />
      </dl>
    </section>
  );
}

function ReleaseMetadata({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-1 break-all font-semibold text-slate-200">
        {code ? <code>{value}</code> : value}
      </dd>
    </div>
  );
}

function ImportAvailability() {
  const { messages } = useUiLocale();
  return (
    <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-labelledby="import-options-heading">
      <h2 id="import-options-heading" className="sr-only">
        {messages["projects.inputOptions"]}
      </h2>
      <AvailabilityCard
        title={messages["projects.dbmlFile"]}
        status={messages["projects.available"]}
        detail={messages["projects.dbmlDetail"]}
      />
      <AvailabilityCard
        title={messages["projects.sqlDdl"]}
        status={messages["projects.available"]}
        detail={messages["projects.sqlDetail"]}
        to="/sql-import/new"
      />
      <AvailabilityCard
        title={messages["projects.bundle"]}
        status={messages["projects.available"]}
        detail={messages["projects.bundleDetail"]}
        to="/project-bundles/import"
        actionLabel={messages["projects.importBundle"]}
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
  const { messages } = useUiLocale();
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-white">{title}</h3>
        <span className="text-xs font-semibold text-cyan-300">{status}</span>
      </div>
      <p className="mt-2 text-sm text-slate-400">{detail}</p>
      {to ? (
        <Link className={`${secondaryButtonClass} mt-4`} to={to}>
          {actionLabel ?? messages["projects.startSqlImport"]}
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
  const { formatDate, locale, messages } = useUiLocale();
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
        <Metadata label={messages["runtime.parser"]} value={project.parserVersion} />
        <Metadata
          label={messages["projects.metadataRevision"]}
          value={String(project.schemaRevisionNo)}
        />
      </dl>
      <p className="mt-4 text-sm text-slate-300">
        {diagnosticSummaryLabel(project.diagnosticSummary, locale)}
      </p>
      <p className="mt-2 text-xs text-slate-400">
        {messages["projects.updated"](
          formatDate(project.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
        )}
      </p>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        <Link
          className={primaryButtonClass}
          aria-label={messages["projects.openNamed"](project.name)}
          to={`/projects/${project.id}`}
        >
          {messages["action.open"]}
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
        {label} {value}
      </dd>
    </div>
  );
}

export function ValidityBadge({ validity }: { readonly validity: "VALID" | "INVALID" }) {
  const valid = validity === "VALID";
  const { messages } = useUiLocale();
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold ${
        valid
          ? "border-emerald-400/40 bg-emerald-950/50 text-emerald-200"
          : "border-amber-400/50 bg-amber-950/50 text-amber-100"
      }`}
    >
      <span aria-hidden="true">{valid ? "✓" : "!"}</span>
      {valid ? messages["projects.draftValid"] : messages["projects.draftInvalid"]}
    </span>
  );
}

function CreateProjectDialog() {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const runtimeLimits = useRuntimeResourceLimits();
  const { messages } = useUiLocale();
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
      setFileError(messages["projects.fileTooLarge"](runtimeLimits.maxSourceBytes));
      return;
    }
    setReadingFile(true);
    try {
      const text = await file.text();
      if (fileReadSequence.current !== sequence) return;
      if (utf8ByteLength(text) > runtimeLimits.maxSourceBytes) {
        setFileError(messages["projects.fileTooLarge"](runtimeLimits.maxSourceBytes));
        return;
      }
      setSource(text);
      setFileName(file.name);
    } catch {
      if (fileReadSequence.current !== sequence) return;
      setFileError(messages["projects.fileReadError"]);
    } finally {
      if (fileReadSequence.current === sequence) setReadingFile(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(new Error(messages["projects.enterName"]));
      nameInputRef.current?.focus();
      return;
    }
    if (sourceMode === "DBML_FILE" && !fileName) {
      setFormError(new Error(messages["projects.chooseFileBeforeCreate"]));
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
          {messages["projects.new"]}
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title={messages["projects.createTitle"]}
        description={messages["projects.createDescription"]}
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField
            ref={nameInputRef}
            label={messages["projects.name"]}
            value={name}
            onChange={setName}
          />
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            {messages["projects.primaryDialect"]}
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
            <legend className="text-sm font-semibold text-slate-200">
              {messages["projects.startFrom"]}
            </legend>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-700 px-3 text-sm">
              <input
                type="radio"
                name="source-mode"
                value="EMPTY"
                checked={sourceMode === "EMPTY"}
                onChange={() => setSourceMode("EMPTY")}
              />
              {messages["projects.emptyDbml"]}
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-700 px-3 text-sm">
              <input
                type="radio"
                name="source-mode"
                value="DBML_FILE"
                checked={sourceMode === "DBML_FILE"}
                onChange={() => setSourceMode("DBML_FILE")}
              />
              {messages["projects.dbmlFile"]}
            </label>
          </fieldset>
          {sourceMode === "DBML_FILE" ? (
            <label className="grid gap-2 text-sm font-semibold text-slate-200">
              {messages["projects.chooseDbml"]}
              <input
                className={`${inputClass} py-2 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-1 file:text-slate-100`}
                type="file"
                accept=".dbml,text/plain"
                onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
              />
              {readingFile ? (
                <span className="text-xs text-slate-400">{messages["projects.readingFile"]}</span>
              ) : null}
              {fileName ? <span className="text-xs text-cyan-300">{fileName}</span> : null}
              {fileError ? <span className="text-xs text-red-200">{fileError}</span> : null}
            </label>
          ) : null}
          <MutationError error={formError} />
          <DialogActions
            submitLabel={messages["projects.createTitle"]}
            pendingLabel={messages["projects.creating"]}
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
  const { messages } = useUiLocale();
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
      setFormError(new Error(messages["projects.enterName"]));
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
          aria-label={messages["projects.renameNamed"](project.name)}
        >
          {messages["action.rename"]}
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title={messages["projects.renameTitle"]}
        description={messages["projects.renameDescription"]}
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField
            ref={nameInputRef}
            label={messages["projects.name"]}
            value={name}
            onChange={setName}
          />
          <MutationError error={formError} />
          <DialogActions
            submitLabel={messages["projects.saveName"]}
            pendingLabel={messages["action.saving"]}
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
  const { messages } = useUiLocale();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => messages["projects.copySuffix"](project.name));
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
      setName(messages["projects.copySuffix"](project.name));
      setFormError(undefined);
    }
    setOpen(nextOpen);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(new Error(messages["projects.enterName"]));
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
          aria-label={messages["projects.duplicateNamed"](project.name)}
        >
          {messages["action.duplicate"]}
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title={messages["projects.duplicateTitle"]}
        description={messages["projects.duplicateDescription"]}
        initialFocusRef={nameInputRef}
      >
        <form className="mt-5 grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <TextField
            ref={nameInputRef}
            label={messages["projects.name"]}
            value={name}
            onChange={setName}
          />
          <MutationError error={formError} />
          <DialogActions
            submitLabel={messages["projects.duplicateTitle"]}
            pendingLabel={messages["projects.duplicating"]}
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
  const { messages } = useUiLocale();
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
        <button
          className={dangerButtonClass}
          type="button"
          aria-label={messages["projects.deleteNamed"](project.name)}
        >
          {messages["action.delete"]}
        </button>
      </Dialog.Trigger>
      <ProjectDialogContent
        title={messages["projects.deleteQuestion"](project.name)}
        description={messages["projects.deleteDescription"]}
        initialFocusRef={cancelRef}
      >
        <div className="mt-5 rounded-lg border border-amber-400/40 bg-amber-950/40 p-4 text-sm text-amber-100">
          {messages["projects.deleteWarning"]}
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
              {messages["action.cancel"]}
            </button>
          </Dialog.Close>
          <button
            className={dangerButtonClass}
            type="button"
            disabled={mutation.isPending}
            onClick={() => void handleDelete()}
          >
            {mutation.isPending
              ? messages["projects.deleting"]
              : messages["projects.deleteProject"]}
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
  const { messages } = useUiLocale();
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Dialog.Close asChild>
        <button className={secondaryButtonClass} type="button" disabled={pending}>
          {messages["action.cancel"]}
        </button>
      </Dialog.Close>
      <button className={primaryButtonClass} type="submit" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </div>
  );
}

function MutationError({ error }: { readonly error: unknown }) {
  const { messages } = useUiLocale();
  if (!error) return null;
  const apiError = error instanceof ProjectApiError ? error : undefined;
  const conflict = apiError?.code === "PROJECT_SCHEMA_REVISION_CONFLICT";
  const localMessage = error instanceof Error && !apiError ? error.message : undefined;
  const message = conflict
    ? messages["projects.conflict"](apiError.currentRevisionNo ?? null)
    : (localMessage ?? messages["projects.updateError"]);

  return (
    <div
      className="rounded-lg border border-red-400/40 bg-red-950/30 p-3 text-sm text-red-100"
      role="alert"
      aria-live="assertive"
    >
      <p>{message}</p>
      {apiError?.correlationId ? (
        <p className="mt-2 text-xs text-red-100/75">
          {messages["error.correlationId"](apiError.correlationId)}
        </p>
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

export function diagnosticSummaryLabel(
  summary: ProjectSummary["diagnosticSummary"],
  locale: UiLocale = "en",
): string {
  if (locale === "ko") {
    return `오류 ${summary.errors}개 · 경고 ${summary.warnings}개 · 정보 ${summary.infos}개`;
  }
  return `${summary.errors} ${pluralize(summary.errors, "error")} · ${summary.warnings} ${pluralize(summary.warnings, "warning")} · ${summary.infos} info`;
}

export function dialectLabel(dialect: PrimaryDialect): string {
  return dialect === "POSTGRESQL" ? "PostgreSQL" : "MySQL";
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
