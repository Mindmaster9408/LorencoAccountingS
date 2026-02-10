FROM node:20-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json ./
RUN npm install --production

# Copy source code
COPY src/ ./src/
COPY public/ ./public/
COPY uploads/ ./uploads/
COPY migrations/ ./migrations/

# Expose port
EXPOSE 3000

# Start
CMD ["node", "src/server.js"]
