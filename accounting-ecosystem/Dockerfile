FROM node:18-alpine

WORKDIR /app

# Install backend dependencies (separate layer for Docker cache efficiency)
COPY backend/package*.json backend/
RUN cd backend && npm install --production

# Copy backend source
COPY backend/ backend/

# Copy all frontend applications (explicit — prevents build tool from collapsing to backend-only)
COPY frontend-ecosystem/ frontend-ecosystem/
COPY frontend-payroll/ frontend-payroll/
COPY frontend-pos/ frontend-pos/
COPY frontend-accounting/ frontend-accounting/
COPY frontend-coaching/ frontend-coaching/
COPY frontend-sean/ frontend-sean/

EXPOSE 3000

CMD ["node", "backend/server.js"]
