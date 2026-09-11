FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/state.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
