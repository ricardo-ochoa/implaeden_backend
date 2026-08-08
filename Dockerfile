# syntax=docker/dockerfile:1
# ============================================================================
# Imagen del backend Express de Implaedén (producción).
# Base Debian slim (glibc) para que bcrypt use sus binarios precompilados
# sin necesitar toolchain de compilación.
# ============================================================================
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# 1) Dependencias primero (mejor cache): copia manifiestos e instala solo prod.
COPY package.json package-lock.json* yarn.lock* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev; fi

# 2) Código de la app.
COPY . .

# El backend escucha en el PORT que reciba por env (por defecto 4000).
EXPOSE 4000

# Arranca en modo producción (carga .env.production si existe, pero en
# contenedor las variables llegan por 'environment' del compose).
CMD ["node", "app.js"]
