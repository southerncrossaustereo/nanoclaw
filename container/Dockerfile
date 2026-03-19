# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# Install kubectl
RUN curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /" > /etc/apt/sources.list.d/kubernetes.list \
    && apt-get update && apt-get install -y kubectl \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Atlassian CLI (acli)
RUN curl -fsSL https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli -o /usr/local/bin/acli \
    && chmod +x /usr/local/bin/acli

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Copy utility scripts (atlassian-api wrapper, etc.)
COPY scripts/ /usr/local/share/nanoclaw-scripts/
RUN if [ -f /usr/local/share/nanoclaw-scripts/atlassian-api ]; then \
      ln -s /usr/local/share/nanoclaw-scripts/atlassian-api /usr/local/bin/atlassian-api; \
    fi

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/ipc/conversations

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN cat > /app/entrypoint.sh <<'ENTRY' && chmod +x /app/entrypoint.sh
#!/bin/bash
set -e

# Compile agent-runner TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Authenticate Azure CLI via service principal if credentials are provided
if [ -n "${AZURE_CLIENT_ID:-}" ] && [ -n "${AZURE_CLIENT_SECRET:-}" ] && [ -n "${AZURE_TENANT_ID:-}" ]; then
  az login --service-principal \
    -u "$AZURE_CLIENT_ID" \
    -p "$AZURE_CLIENT_SECRET" \
    -t "$AZURE_TENANT_ID" \
    --output none 2>&1 >&2 && echo "Azure: authenticated as service principal" >&2 || echo "Azure: login failed" >&2
fi

# Authenticate Atlassian CLI if credentials are provided.
# Service account tokens (ATSTT prefix) use Bearer auth via atlassian-api wrapper.
# Classic API tokens use acli's built-in basic auth login.
if [ -n "${ACLI_TOKEN:-}" ] && [ -n "${ACLI_SITE:-}" ] && [ -n "${ACLI_EMAIL:-}" ]; then
  if echo "$ACLI_TOKEN" | grep -q "^ATSTT"; then
    echo "Atlassian: service account token detected, using atlassian-api wrapper" >&2
  else
    echo "$ACLI_TOKEN" | acli jira auth login --site "$ACLI_SITE" --email "$ACLI_EMAIL" --token 2>&1 >&2 || true
    echo "$ACLI_TOKEN" | acli confluence auth login --site "$ACLI_SITE" --email "$ACLI_EMAIL" --token 2>&1 >&2 || true
  fi
fi

# Read input and run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
ENTRY

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
