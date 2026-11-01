FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY skills ./skills
COPY src ./src
COPY public ./public
COPY scripts/build.sh ./scripts/build.sh
COPY scripts/atlas-smoke.ts ./scripts/atlas-smoke.ts
RUN npm run check && npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
# Optional Pi subagent engine is pinned and only activated by RELAY_PI_SUBAGENTS=1.
# Package scripts are never executed; the extension remains untrusted code
# until the operator intentionally opts in after reviewing the package.
RUN npm install --no-save --omit=dev --ignore-scripts --no-audit --no-fund @tintinweb/pi-subagents@0.22.1
# Validate the actual published package. A successful npm install alone
# does not prove that Pi's TypeScript extension entrypoint is shipped.
RUN node -e "const r=require('node:module').createRequire(process.cwd()+'/package.json'); const fs=require('node:fs'); const path=require('node:path'); const p=r.resolve('@tintinweb/pi-subagents/package.json'); const m=r(p); if(m.name!=='@tintinweb/pi-subagents'||m.version!=='0.22.1'||!fs.existsSync(path.join(path.dirname(p),'src','index.ts')))process.exit(1)"

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Pi may create an ephemeral model catalog/cache; keep writes in Docker tmpfs.
ENV HOME=/tmp
ENV PI_CODING_AGENT_DIR=/tmp/.pi
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
COPY .pi ./.pi
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8765
CMD ["node", "dist/server.js"]
