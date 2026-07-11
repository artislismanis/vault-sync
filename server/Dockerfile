# Both stages MUST use the same Node image: better-sqlite3 is a native module
# and NODE_MODULE_VERSION must match at runtime. Debian (not Alpine) so npm
# uses prebuilt binaries instead of compiling from source.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY plugin/package.json plugin/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
# shared/ is TS-source and gets bundled in; better-sqlite3 stays external.
RUN npm run build -w server

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/server/dist/ ./dist/
COPY server/docker/runtime-package.json ./package.json
# Installs only better-sqlite3 (the lone unbundleable runtime dep).
RUN npm install --omit=dev --no-audit --no-fund
RUN useradd -r -u 10001 vaultsync && mkdir -p /data && chown vaultsync /data
USER vaultsync
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "dist/index.cjs"]
