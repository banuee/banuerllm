FROM node:22-alpine

WORKDIR /app

# Copy dependency definition
COPY package.json ./

# Copy source code and assets
COPY src/ ./src/
COPY public/ ./public/

# Create persistent data directory
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/banuerllm.db

EXPOSE 3000

CMD ["node", "src/server.js"]
