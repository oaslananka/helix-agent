# Deployment Guide

## Single Machine Deployment

### Prerequisites

- Docker and Docker Compose installed
- Access to gateway WebSocket URL
- Agent key from gateway administrator

### Steps

1. **Clone the repository**:
   ```bash
   git clone <repo-url> helix-agent
   cd helix-agent
   ```

2. **Create environment file**:
   ```bash
   cat > .env << EOF
   AGENT_ID=home-pc-1
   AGENT_NAME="My Home PC"
   GATEWAY_WS_URL=wss://gateway.your-domain.com/agent/ws
   AGENT_KEY=<your-secret-key>
   REPO_ROOTS_JSON='["/repo"]'
   LOG_LEVEL=info
   ENABLE_GIT=true
   ENABLE_RUNNER=false
   EOF
   ```

3. **Prepare repository mount** (optional):
   ```bash
   # If you have a local repo you want to expose:
   mkdir -p myrepo
   cd myrepo
   git clone <your-project>
   cd ..
   ```

4. **Update docker-compose.yml** if needed:
   - Change `./myrepo:/repo:ro` to your actual repo path
   - Add environment variables as needed

5. **Start the agent**:
   ```bash
   docker-compose up -d
   ```

6. **Verify it's running**:
   ```bash
   docker-compose logs agent
   # Should see: "Connected to gateway" and "Registered with gateway"
   ```

7. **Test with the gateway**:
   - From the gateway, call `repo.list_tree` to verify connectivity

### Updating

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose up -d --build
```

### Stopping

```bash
docker-compose down
```

## Multi-Machine / Kubernetes Deployment

### Docker Image Registry

1. **Build and push image**:
   ```bash
   docker build -t your-registry/helix-home-agent:1.0.0 .
   docker push your-registry/helix-home-agent:1.0.0
   ```

2. **Pull on remote machine**:
   ```bash
   docker pull your-registry/helix-home-agent:1.0.0
   docker run -d \
     --name helix-agent \
     -e AGENT_ID=home-pc-2 \
     -e AGENT_NAME="Remote Dev PC" \
     -e GATEWAY_WS_URL=wss://gateway.example.com/agent/ws \
     -e AGENT_KEY=<key> \
     -e REPO_ROOTS_JSON='["/repo"]' \
     -v /path/to/repo:/repo:ro \
     your-registry/helix-home-agent:1.0.0
   ```

### Kubernetes

1. **Create ConfigMap**:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: agent-config
   data:
     AGENT_ID: "k8s-agent-1"
     AGENT_NAME: "K8s Cluster Agent"
     LOG_LEVEL: "info"
     ENABLE_GIT: "true"
     ENABLE_RUNNER: "false"
   ```

2. **Create Secret**:
   ```bash
   kubectl create secret generic agent-secret \
     --from-literal=GATEWAY_WS_URL=wss://gateway.example.com/agent/ws \
     --from-literal=AGENT_KEY=<your-key>
   ```

3. **Create Deployment**:
   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: helix-agent
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: helix-agent
     template:
       metadata:
         labels:
           app: helix-agent
       spec:
         containers:
         - name: agent
           image: your-registry/helix-home-agent:1.0.0
           imagePullPolicy: Always
           envFrom:
           - configMapRef:
               name: agent-config
           - secretRef:
               name: agent-secret
           env:
           - name: REPO_ROOTS_JSON
             value: '["/repo"]'
           volumeMounts:
           - name: repo
             mountPath: /repo
             readOnly: true
           resources:
             requests:
               cpu: 100m
               memory: 128Mi
             limits:
               cpu: 500m
               memory: 512Mi
         volumes:
         - name: repo
           emptyDir: {} # Or hostPath, PVC, etc.
   ```

4. **Deploy**:
   ```bash
   kubectl apply -f deployment.yaml
   ```

5. **Monitor**:
   ```bash
   kubectl logs -f deployment/helix-agent
   ```

## Security Considerations

1. **Network**:
   - Ensure WebSocket is over TLS (wss://)
   - Restrict outbound firewall if possible (only to gateway)
   - Use strong agent keys (min 32 chars)

2. **Filesystem**:
   - Always mount repos read-only (`:ro`)
   - Run container as non-root user (Dockerfile does this)
   - Avoid exposing sensitive files in REPO_ROOTS_JSON

3. **Command Execution**:
   - Keep ENABLE_RUNNER=false unless necessary
   - If enabling, use strict allowlist
   - Avoid test commands that invoke shell
   - Set RUNNER_TIMEOUT_MS appropriately

4. **Docker Socket**:
   - Only enable ENABLE_DOCKER if needed
   - Mount socket read-only
   - Limit container command permissions

5. **Logs**:
   - Redact API keys with REDACT_REGEXES_JSON
   - Rotate logs to prevent disk fill
   - Don't log sensitive environment variables

## Troubleshooting Deployment

### Agent crashes immediately

Check logs:
```bash
docker-compose logs agent
```

Common issues:
- `GATEWAY_WS_URL` incorrect or unreachable
- `AGENT_KEY` mismatch
- `REPO_ROOTS_JSON` invalid JSON or non-existent paths

### Connection drops

- Network instability: Check firewall, proxy settings
- Gateway issues: Verify gateway is running
- Agent key changed: Update .env and restart

### High memory usage

- Reduce `MAX_OUTPUT_BYTES` and `MAX_FILE_BYTES`
- Lower `MAX_SEARCH_MATCHES`
- Avoid searching in large directories

### Permission denied errors

- Check mount permissions: `-v /path:/path:ro`
- Verify file ownership in mounted volumes
- For Docker socket: ensure daemon is accessible

## Monitoring

### Logs

```bash
# Real-time logs
docker-compose logs -f agent

# Last 100 lines
docker-compose logs --tail 100 agent

# JSON parsing
docker-compose logs agent | jq 'select(.msg | contains("error"))'
```

### Health

```bash
# Check container status
docker-compose ps

# Inspect container
docker inspect helix-agent

# Test connectivity (from container)
docker exec helix-agent wget -O- https://example.com
```

### Metrics

The agent logs structured JSON. Key metrics to monitor:

- Connection status: "Connected to gateway"
- Tool execution time and errors
- Concurrent call queue length
- Disconnections and reconnect attempts

Example Prometheus metrics could be added to send periodic metrics to gateway.

## Backup & Recovery

### Backing up configuration

```bash
# Save environment
cp .env .env.backup

# Save docker-compose setup
cp docker-compose.yml docker-compose.yml.backup
```

### Recovering from failure

```bash
# Restart container
docker-compose restart agent

# Full restart
docker-compose down
docker-compose up -d

# Check logs
docker-compose logs agent
```

## Scaling

For multiple agents on same machine:

```yaml
services:
  agent-1:
    build: .
    container_name: helix-agent-1
    environment:
      AGENT_ID: agent-1
      # ... other config
    volumes:
      - /repo1:/repo:ro

  agent-2:
    build: .
    container_name: helix-agent-2
    environment:
      AGENT_ID: agent-2
      # ... other config
    volumes:
      - /repo2:/repo:ro
```

Each agent with different REPO_ROOTS_JSON and repo mount.

## Maintenance

### Regular tasks

- **Weekly**: Check logs for errors
- **Monthly**: Review and rotate logs
- **Quarterly**: Update agent version

### Updating agent

```bash
git pull origin main
docker-compose down
docker-compose build --no-cache
docker-compose up -d
docker-compose logs agent
```

### Cleaning up

```bash
# Remove stopped containers
docker container prune

# Remove unused images
docker image prune

# Remove unused volumes
docker volume prune
```
