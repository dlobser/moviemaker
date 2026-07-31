# MovieMaker: build the frontend, then run the backend that serves it.
#
# One process, one port. The Vite dev server is a development tool (HMR), so it
# has no place in the image — the built bundle is served by Express instead.

# --- build the frontend ------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime -----------------------------------------------------------------
# node:22-slim, not alpine: rolldown/esbuild ship prebuilt native bindings and
# the glibc ones are the well-trodden path. ffmpeg is not optional here — it is
# the only thing the backend can do that the static build cannot.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# No `npm ci`: the root package-lock.json is not committed.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js renderGraph.js ./
COPY --from=build /app/frontend/dist ./frontend/dist

# Config and projects live on a volume, not in this layer, so they survive a
# rebuild. See compose.yaml.
ENV PORT=3001 \
    MOVIEMAKER_ROOT=/projects \
    MOVIEMAKER_CONFIG=/projects/config.json
RUN mkdir -p /projects && chown node:node /projects
USER node

EXPOSE 3001
CMD ["node", "server.js"]
