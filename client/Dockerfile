# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# The demo account's API key is kept here so restarts reuse the same account (docker volume).
RUN mkdir /data && chown node:node /data
ENV STATE_FILE=/data/state.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
