# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Lockfile-only layer so dependency installs cache across source edits.
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

COPY . .
RUN npm run build

# --- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
