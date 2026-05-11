FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx

COPY . .

EXPOSE 38412

CMD ["npx", "tsx", "server.ts"]
