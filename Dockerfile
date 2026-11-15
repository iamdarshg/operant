# Operant — one image for the control plane (API), the job worker, and the
# Discord bot. Three commands, identical dependency layers — which is what makes
# a clone-and-run deployment predictable.
#
# Portable by construction: no host absolute paths, no build-time secrets, and
# the DSH agent runtime is baked in so the container does not depend on a host
# DSH installation.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.19.0

# ---------------------------------------------------------------- dependencies
FROM base AS deps
WORKDIR /app
# Copy manifests first so a source edit does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY packages/core/package.json           packages/core/
COPY packages/db/package.json             packages/db/
COPY packages/dsh-adapter/package.json    packages/dsh-adapter/
COPY packages/memory/package.json         packages/memory/
COPY packages/learning/package.json       packages/learning/
COPY packages/mcp-client/package.json     packages/mcp-client/
COPY packages/ui/package.json             packages/ui/
COPY packages/web-search-ddg/package.json packages/web-search-ddg/
COPY apps/api/package.json                apps/api/
COPY apps/worker/package.json             apps/worker/
COPY apps/bot/package.json                apps/bot/
COPY apps/web/package.json                apps/web/
RUN pnpm install --frozen-lockfile=false

# --------------------------------------------------------------------- compile
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm --filter @operant/core --filter @operant/db --filter @operant/dsh-adapter \
         --filter @operant/api --filter @operant/worker run build

# ---------------------------------------------------------------------- runtime
FROM base AS runtime
WORKDIR /app

# The agent runtime, pinned. `@deepseek-ai/dsh` publishes prereleases only, and an
# unversioned install resolves to `@*` which excludes prereleases and fails with
# ETARGET — so the version is explicit on purpose.
ARG DSH_VERSION=0.2.2-rc.1
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
      --registry=https://registry.npmjs.org/

RUN useradd --system --create-home --uid 10001 operant
COPY --from=build --chown=operant:operant /app/node_modules        ./node_modules
COPY --from=build --chown=operant:operant /app/packages            ./packages
COPY --from=build --chown=operant:operant /app/apps                ./apps
COPY --from=build --chown=operant:operant /app/package.json        ./package.json
COPY --from=build --chown=operant:operant /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# The Operant DSH profile, versioned in the repo, installed where DSH looks for it.
COPY services/dsh/profiles/operant /home/operant/.dsh/profiles/operant
# Link the in-repo keyless search provider into that profile (no registry needed).
RUN chown -R operant:operant /home/operant/.dsh \
 && su operant -s /bin/sh -c 'cd /home/operant/.dsh/profiles/operant && pnpm install --silent' \
 || echo "WARN: profile link step failed; web_search will be unavailable"

RUN mkdir -p /app/data/jobs /app/data/logs && chown -R operant:operant /app/data
USER operant
ENV OPERANT_WORKSPACE_ROOT=/app/data/jobs \
    OPERANT_DSH_PROFILE=operant
# tini reaps the `dsh` grandchildren the worker spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]