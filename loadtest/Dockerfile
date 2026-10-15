# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENTRYPOINT ["npx", "tsx", "src/load.ts"]
CMD ["--scenario", "all", "--url", "http://service:3000", "--label", "compose"]
