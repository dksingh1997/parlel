FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

EXPOSE 6379

CMD ["node", "src/index.js"]
