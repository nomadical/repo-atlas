# Build the viz with the Keycloak login gate + the authed data URL baked in, then serve it — plus a
# token-validated /data route — from the tiny node server in server/. Run it behind whatever ingress
# you use, at BASE_PATH (default /repo-atlas). See infra/hosting.md.
#
#   docker build -t repo-atlas \
#     --build-arg VITE_AUTH_SERVER_URL=https://id.example.com/ \
#     --build-arg VITE_REALM=my-realm --build-arg VITE_RESOURCE=repo-atlas .
#   docker run -p 8080:8080 -e AUTH_ISSUER=https://id.example.com/realms/my-realm repo-atlas

FROM node:22-alpine AS build
# Repository layout in both stages: golden-path/ must sit beside viz/ and server/, because both
# import it by relative path.
WORKDIR /app/viz
COPY viz/package.json viz/package-lock.json ./
RUN npm ci
COPY viz/ ./
COPY golden-path/lib /app/golden-path/lib
# Baked into the bundle: activates the Keycloak gate and points data fetches at the authed route.
ARG VITE_AUTH_SERVER_URL
ARG VITE_REALM
ARG VITE_RESOURCE
ARG VITE_DATA_URL=/repo-atlas/data
ENV VITE_AUTH_SERVER_URL=$VITE_AUTH_SERVER_URL \
    VITE_REALM=$VITE_REALM \
    VITE_RESOURCE=$VITE_RESOURCE \
    VITE_DATA_URL=$VITE_DATA_URL
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production PORT=8080
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/server.mjs server/blob-store.mjs ./
# Data served (only) by the token-gated route; rebuild the image to pick up a data refresh.
# config.json carries the admin-curated page title; inventory-extra.json and service-map.json
# feed the Admin panel's Documentation and Services tabs (server.mjs reads all five).
COPY fe-architecture.json fe-architecture-extras.json config.json inventory-extra.json service-map.json ./
COPY --from=build /app/viz/dist ./dist
# The decision log is baked in only so today's decisions are visible; writes to it die with the
# container until GP_DECISION_LOG points at durable storage.
COPY golden-path/history.json golden-path/rules.json golden-path/exceptions.jsonl /app/golden-path/
COPY golden-path/lib /app/golden-path/lib
EXPOSE 8080
# The server only reads baked-in files — no reason to run as root. (The in-image decision-log
# fallback becomes read-only for node, which is fine: deployments set GP_DECISION_LOG.)
USER node
# /health at root exists for exactly this (server.mjs); busybox wget ships in alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "server.mjs"]
