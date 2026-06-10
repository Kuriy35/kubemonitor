# ========================================================
# Stage 1: Build dependencies in isolated builder image
# ========================================================
FROM python:3.11-slim AS builder

WORKDIR /build

# Install dependencies needed to compile python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .

# Install pip dependencies to a local folder to easily copy them
RUN pip install --no-cache-dir --user -r requirements.txt

# ========================================================
# Stage 2: Final minimal running image (Hardened)
# ========================================================
FROM python:3.11-slim AS runner

WORKDIR /app

# Install minimal runtime dependencies (libpq5 for postgres if needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Security Hardening: Create a non-privileged user and group
# running with custom UID 10001 to prevent root privileges escalation
RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /sbin/nologin -c "Application User" appuser

# Copy installed libraries from the builder
COPY --from=builder /root/.local /home/appuser/.local

# Copy application files (backend and frontend files)
# Ensure they are owned by the non-root user
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

RUN chown -R appuser:appgroup /app

# Set PATH variables and python environments
ENV PATH=/home/appuser/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Run as non-root
USER appuser

EXPOSE 8000

# Docker Healthcheck to verify local API state
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
