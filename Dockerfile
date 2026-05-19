FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY knexfile.cjs ./
COPY migrations ./migrations
COPY docker-entrypoint.cjs ./

RUN useradd --create-home --uid 10001 appuser \
  && mkdir -p /app/data \
  && chown -R appuser:appuser /app

USER appuser

ENTRYPOINT ["node", "docker-entrypoint.cjs"]
CMD ["node", "dist/index.js"]
