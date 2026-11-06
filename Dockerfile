# Build: install everything, build the page, then drop packages only needed for building and tests.
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Run: a slim image holding only what the hub needs.
FROM node:20-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
WORKDIR /app
RUN chown node:node /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/core ./src/core
COPY --from=build --chown=node:node /app/src/hub ./src/hub
# The team's simulation, a static app served under /sim/.
COPY --from=build --chown=node:node /app/sim ./sim
# The C06 card reads the last real-browser accessibility report from here.
COPY --from=build --chown=node:node /app/results ./results
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/hub/main.ts"]
