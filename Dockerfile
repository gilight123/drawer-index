FROM node:20-alpine

WORKDIR /app

# install production deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# app code
COPY server.js ./
COPY public ./public

ENV DATA_DIR=/data
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
