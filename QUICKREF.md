# Quick Reference

## Startup

### Development
```bash
npm install
npm run dev
```

### Production (Docker)
```bash
docker-compose up -d
docker-compose logs -f agent
```

## Configuration

### Minimal .env
```
AGENT_ID=home-pc-1
AGENT_NAME=Home PC
GATEWAY_WS_URL=wss://gateway.example.com/agent/ws
AGENT_KEY=your-secret-key
REPO_ROOTS_JSON='["/repo"]'
```

### Common Options
```
# Enable features
ENABLE_GIT=true
ENABLE_RUNNER=false
ENABLE_DOCKER=false
ENABLE_HTTP_FETCH=false

# Limits
MAX_OUTPUT_BYTES=200000
MAX_FILE_BYTES=2000000

# Timeouts
WS_PING_INTERVAL_MS=15000
WS_RECONNECT_MAX_MS=30000
```

## Available Tools

### Repo Tools (Always Available)
- `repo.list_tree` - List directory structure
- `repo.read_file` - Read file content
- `repo.search_rg` - Search with ripgrep

### Git Tools (if ENABLE_GIT=true)
- `git.status` - Repository status
- `git.diff` - Show differences
- `git.show` - Show commit details

### Optional Tools
- `runner.exec` - Run commands (ENABLE_RUNNER)
- `logs.tail_file` - Tail log files
- `docker.ps` - List containers (ENABLE_DOCKER)
- `docker.logs` - Get container logs (ENABLE_DOCKER)
- `http.fetch_local` - Fetch from local endpoints (ENABLE_HTTP_FETCH)

## File Locations

### Source Code
- Entry point: `src/index.ts`
- Config: `src/config/env.ts`
- Protocol: `src/net/protocol.ts`
- WebSocket: `src/net/wsClient.ts`
- Tools: `src/tools/*/`
- Security: `src/security/`

### Configuration
- Example env: `.env.example`
- Docker: `docker-compose.yml`, `Dockerfile`
- TypeScript: `tsconfig.json`
- Tests: `vitest.config.ts`

### Documentation
- User guide: `README.md`
- Deployment: `DEPLOYMENT.md`
- Development: `DEVELOPMENT.md`

## Commands

### Development
```bash
npm run build       # Compile TypeScript
npm run dev         # Run with tsx (live reload)
npm test            # Run tests
npm run lint        # Check code style
npm run typecheck   # Type check
```

### Docker
```bash
docker-compose up -d        # Start
docker-compose logs -f      # Logs
docker-compose restart      # Restart
docker-compose down         # Stop
docker-compose up -d --build  # Rebuild
```

## Troubleshooting

### Won't connect
- Check `GATEWAY_WS_URL` and `AGENT_KEY`
- Check firewall allows WebSocket
- Check logs: `docker-compose logs agent`

### Tool not found
- Verify tool is registered in `src/index.ts`
- Check feature flag is enabled (e.g., ENABLE_GIT)
- Check tool name matches call (use `repo.read_file` not `repo_read_file`)

### High memory
- Reduce `MAX_OUTPUT_BYTES`
- Reduce `MAX_FILE_BYTES`
- Use smaller `MAX_SEARCH_MATCHES`

### Timeout errors
- Increase tool timeout in gateway call
- Check for long-running tools
- Verify network latency

## Protocol Format

### Register (agent → gateway)
```json
{
  "type": "register",
  "protocolVersion": 1,
  "agentId": "home-pc-1",
  "agentName": "Home PC",
  "meta": {...},
  "capabilities": {"tools": [...]}
}
```

### Call (gateway → agent)
```json
{
  "type": "call",
  "requestId": "uuid",
  "domain": "tools",
  "name": "repo.read_file",
  "arguments": {"path": "file.txt"},
  "timeoutMs": 30000
}
```

### Result (agent → gateway)
```json
{
  "type": "call_result",
  "requestId": "uuid",
  "ok": true,
  "result": {"content": [{"type": "text", "text": "..."}]}
}
```

Or error:
```json
{
  "type": "call_result",
  "requestId": "uuid",
  "ok": false,
  "error": {"code": "TIMEOUT", "message": "..."}
}
```

## Adding a Tool

1. Create `src/tools/domain/name.ts`:
   ```typescript
   export function createMyTool(...) {
     return createTool('domain.name', 'Description', Schema, async (args) => {
       return { content: [{ type: 'text', text: result }] };
     });
   }
   ```

2. Register in `src/index.ts`:
   ```typescript
   registry.register(createMyTool(...));
   ```

3. Test and document

That's all!

## Security Notes

- Paths validated against `REPO_ROOTS_JSON`
- Output truncated to `MAX_OUTPUT_BYTES`
- Commands allowlisted if runner enabled
- No execution without explicit configuration
- All tools timeout after specified duration

## Monitoring

### Health Check
```bash
docker inspect helix-agent --format='{{.State.Health.Status}}'
```

### Key Log Indicators
- "Connected to gateway" - Connection OK
- "Registered with gateway" - Registration OK
- "Tool executed" - Execution OK
- Error messages - Issues to investigate

### Logs Query
```bash
# Recent errors
docker-compose logs agent | grep ERROR

# Tool execution time
docker-compose logs agent | jq 'select(.msg | contains("executed"))'
```

## Performance Tips

1. Use ripgrep: `apt-get install ripgrep` in Dockerfile
2. Mount repos read-only: `-v /path:/repo:ro`
3. Set appropriate concurrency: `WS_MAX_CONCURRENT_CALLS=4`
4. Monitor disk usage for logs
5. Use appropriate output limits

## Updating

```bash
git pull
docker-compose down
docker-compose build --no-cache
docker-compose up -d
docker-compose logs agent
```

## Support

- Issues: Check DEVELOPMENT.md for architecture details
- Security: Review src/security/* for validation
- Deployment: See DEPLOYMENT.md for various setups
- Tools: Add new tools without changing core!
