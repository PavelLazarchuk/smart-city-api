FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS dev
WORKDIR /app
COPY . .
ENV NODE_ENV=development
EXPOSE 8080
CMD ["npm", "run", "start:dev"]

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
  && apk add --no-cache curl \
  && mkdir -p /app/uploads && chown -R app:app /app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/migrations ./migrations
COPY --from=build --chown=app:app /app/migrate-mongo-config.js ./migrate-mongo-config.js
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/v1/health/live || exit 1
CMD ["node", "dist/main"]
