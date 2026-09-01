import {
  commandIdSchema,
  projectBundleExportRequestSchema,
  projectBundleImportResponseSchema,
  projectParamsSchema,
} from "@er-diagram/contracts";
import type { ProjectBundleApplication } from "@er-diagram/core";
import type { FastifyInstance } from "fastify";

import { parseRequest, parseResponse, sendProjectBundleApplicationError } from "./http-errors.js";
import {
  extractProjectBundleArchive,
  FileProjectBundleStaging,
  isStagedProjectBundleUpload,
  ProjectBundleTransportError,
  registerProjectBundleContentTypeParser,
  writeProjectBundleArchive,
} from "./project-bundle-archive.js";
import type { ServerResourceLimits } from "./resource-limits.js";

export function registerProjectBundleRoutes(
  server: FastifyInstance,
  application: ProjectBundleApplication,
  resourceLimits: ServerResourceLimits,
): void {
  registerProjectBundleContentTypeParser(server, resourceLimits);

  server.post("/api/v1/projects/:projectId/bundle-export", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(projectBundleExportRequestSchema, request.body);
    const staging = await FileProjectBundleStaging.create();
    let transferred = false;
    try {
      const result = await application.exportBundle({
        projectId,
        expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
        expectedLayoutRevisionNo: command.expectedLayoutRevisionNo,
        ...(command.reportMode === undefined ? {} : { reportMode: command.reportMode }),
        staging,
      });
      if (!result.ok) return sendProjectBundleApplicationError(request, reply, result.error);
      const archive = await writeProjectBundleArchive(staging, resourceLimits);
      const stream = archive.createReadStream();
      const cleanup = () => void staging.cleanup();
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      transferred = true;
      return reply
        .code(200)
        .type("application/zip")
        .header("content-disposition", 'attachment; filename="project.erdiagram.zip"')
        .header("content-length", String(archive.bytes))
        .header("cache-control", "no-store")
        .header("x-bundle-sha256", archive.sha256)
        .send(stream);
    } finally {
      if (!transferred) await staging.cleanup();
    }
  });

  server.post("/api/v1/project-bundles/import", async (request, reply) => {
    if (!isStagedProjectBundleUpload(request.body)) {
      throw new ProjectBundleTransportError(
        "PROJECT_BUNDLE_CONTENT_TYPE_UNSUPPORTED",
        415,
        "Portable bundle imports require application/zip.",
      );
    }
    const commandId = parseRequest(commandIdSchema, request.headers["x-command-id"]);
    reply.header("x-command-id", commandId);
    const upload = request.body;
    let staging: FileProjectBundleStaging | undefined;
    try {
      staging = await extractProjectBundleArchive(upload, resourceLimits);
      const result = await application.importBundle({ staging });
      if (!result.ok) return sendProjectBundleApplicationError(request, reply, result.error);
      return reply.code(201).send(parseResponse(projectBundleImportResponseSchema, result.value));
    } finally {
      await staging?.cleanup();
      await upload.cleanup();
    }
  });
}
