# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG OCI_SOURCE=https://github.com/hojooo/ER-Diagram
ARG OCI_REVISION=development
ARG OCI_VERSION=development
ARG RUNTIME_RELEASE_CHANNEL=DEVELOPMENT
ARG RUNTIME_RELEASE_VERSION=development
ARG RUNTIME_RELEASE_SOURCE_REVISION=
ARG RUNTIME_RELEASE_IMAGE_REFERENCE=

FROM ${NODE_IMAGE} AS builder

ARG RUNTIME_RELEASE_CHANNEL
ARG RUNTIME_RELEASE_VERSION
ARG RUNTIME_RELEASE_SOURCE_REVISION
ARG RUNTIME_RELEASE_IMAGE_REFERENCE

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
WORKDIR /workspace

RUN apt-get update && \
    apt-get install --yes --no-install-recommends g++ make python3 && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/source-transform/package.json packages/source-transform/package.json
COPY packages/storage-sqlite/package.json packages/storage-sqlite/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json

RUN --mount=type=cache,id=er-diagram-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm build
RUN RUNTIME_RELEASE_CHANNEL="${RUNTIME_RELEASE_CHANNEL}" \
    RUNTIME_RELEASE_VERSION="${RUNTIME_RELEASE_VERSION}" \
    RUNTIME_RELEASE_SOURCE_REVISION="${RUNTIME_RELEASE_SOURCE_REVISION}" \
    RUNTIME_RELEASE_IMAGE_REFERENCE="${RUNTIME_RELEASE_IMAGE_REFERENCE}" \
    node scripts/write-release-manifest.mjs /opt/er-diagram/release.json
RUN if [ "${RUNTIME_RELEASE_CHANNEL}" = "RELEASE" ]; then \
      SBOM_VERSION="${RUNTIME_RELEASE_VERSION}"; \
      SBOM_REVISION="${RUNTIME_RELEASE_SOURCE_REVISION}"; \
      SBOM_IMAGE_REFERENCE="${RUNTIME_RELEASE_IMAGE_REFERENCE}"; \
    else \
      SBOM_VERSION="0.0.0"; \
      SBOM_REVISION="0000000000000000000000000000000000000000"; \
      SBOM_IMAGE_REFERENCE="ghcr.io/hojooo/er-diagram:0.0.0"; \
    fi && \
    node scripts/generate-sbom.mjs \
      --output /opt/er-diagram/sbom/er-diagram.cdx.json \
      --version "${SBOM_VERSION}" \
      --revision "${SBOM_REVISION}" \
      --image-reference "${SBOM_IMAGE_REFERENCE}" && \
    install -D -m 0644 \
      node_modules/.pnpm/elkjs@0.12.0/node_modules/elkjs/LICENSE.md \
      /opt/er-diagram/licenses/elkjs-EPL-2.0.txt
RUN --mount=type=cache,id=er-diagram-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm --filter @er-diagram/server deploy --legacy --prod /opt/er-diagram/server

FROM ${NODE_IMAGE} AS runtime

ARG OCI_SOURCE
ARG OCI_REVISION
ARG OCI_VERSION

LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="DBML SQL ERD Studio" \
      org.opencontainers.image.description="Self-hosted DBML and SQL schema workspace"

ENV NODE_ENV=production
WORKDIR /app/server

COPY --from=builder /opt/er-diagram/server /app/server
COPY --from=builder /workspace/apps/web/dist /app/web
COPY --from=builder /opt/er-diagram/release.json /app/release.json
COPY --from=builder /opt/er-diagram/sbom /app/sbom
COPY --from=builder /opt/er-diagram/licenses /app/licenses
COPY --from=builder /workspace/LICENSE /app/LICENSE
COPY --from=builder /workspace/NOTICE /app/NOTICE
COPY --from=builder /workspace/THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md

RUN install -d -m 0700 -o node -g node /data

USER node
EXPOSE 8080

CMD ["node", "dist/production-entrypoint.js"]
