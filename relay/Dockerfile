FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=4701
EXPOSE 4701
USER node
CMD ["node", "server.js"]
