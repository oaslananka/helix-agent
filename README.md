# helix-agent

> Local agent that securely exposes your machine's tools to AI assistants via Helix Gateway.

[![CI](https://github.com/oaslananka/helix-agent/actions/workflows/ci.yml/badge.svg)](...)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](...)

## What is this?

Helix Agent runs on your local machine (home PC, laptop, server) and connects to
[helix-gateway](https://github.com/oaslananka/helix-gateway) via an encrypted WebSocket.
It exposes your local tools — git repos, docker, kubernetes, files — to AI assistants
without exposing your home IP address.

## Architecture

\`\`\`
AI Client (ChatGPT/Claude)
      ↓ HTTPS/MCP
Helix Gateway (VPS)
      ↓ WebSocket (wss://)
Helix Agent (Your Machine)
      ↓ Local calls
  Git | Docker | Files | K8s | DB
\`\`\`

## Quick Start

\`\`\`bash
cp .env.example .env
# Edit .env with your GATEWAY_WS_URL and AGENT_KEY

# Docker (recommended)
docker-compose up -d
docker-compose logs -f agent

# Or directly
npm install && npm run dev &
\`\`\`

## Plugin System

Add custom tools without modifying core code:

\`\`\`
plugins/
  my-tool/
    manifest.json   # Plugin metadata
    index.js        # Tool implementation
\`\`\`

See [Plugin Development Guide](DEVELOPMENT.md#plugins) for details.

## Observability

Supports OpenTelemetry for distributed tracing:

\`\`\`env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
\`\`\`

## Security

- Path traversal protection via `realpath` validation
- Command allowlist for `runner` tools
- Output size limits
- Per-call timeouts
- Concurrent call limiting
- Audit logging
- Sensitive data redaction

## Ecosystem

This agent works with [helix-gateway](https://github.com/oaslananka/helix-gateway).

## Contributing

Built with AI assistance (Claude). Architecture, security design and deployment by the maintainer.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
