# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
# offline_incidents.log is written here; mount a volume on hosts that support one.
RUN mkdir -p /app/data && chown node:node /app/data
ENV OFFLINE_LOG_PATH=/app/data/offline_incidents.log
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
# Apply pending migrations, then start. exec keeps node as PID 1 for clean shutdowns.
CMD ["sh", "-c", "node dist/db/migrate.js up && exec node dist/server.js"]
