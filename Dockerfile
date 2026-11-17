# Not verified locally: Docker is not installed on the machine this was built on.
FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4101 DB_PATH=/data/rag.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
COPY sample-docs ./sample-docs
VOLUME ["/data"]
EXPOSE 4101
CMD ["node", "dist/main.js"]
