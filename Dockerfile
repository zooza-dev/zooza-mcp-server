FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
RUN npm run build

RUN npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
COPY --from=build /app/package.json ./package.json
# Client reports artifact (spec ZMCP-20260612-002) — read at runtime by
# reports_show_report (PAGES registry parse) and served as an MCP resource.
COPY artifacts/business-dashboard.html artifacts/demo-embedded.js ./artifacts/

EXPOSE 3001

USER node
CMD ["node", "dist/index.js"]
