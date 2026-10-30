FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json .
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
USER node
EXPOSE 8765
CMD ["node","src/server.mjs"]
