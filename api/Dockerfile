# Build context: repository root (compose.yaml sets it). No build step: Node 24 runs .ts directly.
FROM node:24.20.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/
RUN npm ci -w api --omit=dev --ignore-scripts
COPY shared ./shared
COPY api ./api
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["node", "src/server.ts"]
