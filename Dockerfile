FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY web ./web
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf server/test server/testing.ts server/preview.ts server/fixtures

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 LEERR_DATA=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -m 700 /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# Node runs the TypeScript sources directly (type stripping) and handles SIGTERM itself.
CMD ["node", "server/main.ts"]
