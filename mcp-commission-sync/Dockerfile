# Multi-stage build: compile TypeScript, then ship a minimal runtime image.
# node:*-slim (Debian/glibc) is used deliberately, not *-alpine - better-sqlite3
# ships prebuilt glibc binaries for common platforms, avoiding a musl/node-gyp
# compile step and its build-tool dependencies in the final image.

FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# SQLite data (diffs/change-requests audit trail) - mount a volume here so it
# survives container restarts/redeploys, not just process restarts. See
# DB_PATH in .env.example / README.md.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server/index.js"]
