FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Pi may create an ephemeral model catalog/cache; keep writes in the Docker tmpfs.
ENV HOME=/tmp
ENV PI_CODING_AGENT_DIR=/tmp/.pi
COPY package.json .
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
USER node
EXPOSE 8765
CMD ["node","src/server.mjs"]
