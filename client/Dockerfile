# Build context: repository root (compose.yaml sets it).
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
RUN npm ci -w client --ignore-scripts
COPY shared ./shared
COPY client ./client
RUN npm run build -w client

FROM nginx:1.30.4-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
