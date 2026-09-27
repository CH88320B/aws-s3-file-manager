FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
