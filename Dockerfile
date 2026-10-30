FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts/build.sh ./scripts/build.sh
RUN npm run check && npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Pi may create an ephemeral model catalog/cache; keep writes in Docker tmpfs.
ENV HOME=/tmp
ENV PI_CODING_AGENT_DIR=/tmp/.pi
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8765
CMD ["node", "dist/server.js"]
