// MUST be first import — before any instrumented libraries
import { initTracing } from './observability/tracing.js';
import { PluginLoader } from './plugins/loader.js';
import { loadConfig } from './config/env.js';
import { runtimeConfig } from './config/runtime.js';
import { logger } from './security/logger.js';
import { auditLogger } from './security/auditLogger.js';
import { createRegistry } from './tools/registry.js';
import { createListTreeTool } from './tools/repo/listTree.js';
import { createReadFileTool } from './tools/repo/readFile.js';
import { createSearchRgTool } from './tools/repo/searchRg.js';
import { createGitStatusTool } from './tools/git/status.js';
import { createGitDiffTool } from './tools/git/diff.js';
import { createGitShowTool } from './tools/git/show.js';
import { createExecTool } from './tools/runner/exec.js';
import { createTailFileTool } from './tools/logs/tailFile.js';
import { createDockerPsTool, createDockerLogsTool } from './tools/docker/docker.js';
import { createFetchLocalTool } from './tools/http/fetchLocal.js';
import { createFileOpsTool } from './tools/system/fileOps.js';
import { createProcessTool } from './tools/system/process.js';
import { createServiceTool } from './tools/system/service.js';
import { createSystemInfoTool } from './tools/system/systemInfo.js';
import { createCapabilitiesTool } from './tools/system/capabilities.js';
import { createDbQueryTool, createDbListTool } from './tools/database/db.js';
import { createK8sPodsTool, createK8sLogsTool, createK8sDescribeTool, createK8sEventsTool } from './tools/k8s/k8s.js';
import { createNetPortsTool, createNetDnsTool, createNetPingTool, createNetCurlTool } from './tools/network/network.js';
import { createMcpDiscoverTool, createMcpCallTool, createMcpListToolsTool } from './tools/mcp/mcpProxy.js';
import { createGeminiTool, createCopilotTool, createSessionStartTool, createSessionInputTool, createSessionReadTool, createSessionStopTool, createSessionListTool } from './tools/cli/cli.js';
import { ConcurrencyController } from './security/policy.js';
import { WSClient } from './net/wsClient.js';
import { DashboardServer } from './dashboard/server.js';

async function main() {
  const initConfig = loadConfig();
  initTracing({
    serviceName: 'helix-agent',
    agentId: initConfig.AGENT_ID,
    serviceVersion: initConfig.AGENT_VERSION,
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: process.env.OTEL_ENABLED !== 'false',
  });
  // Load runtime config overrides first
  await runtimeConfig.load();

  const config = loadConfig();

  // Initialize audit logger
  if (config.AUDIT_LOG_ENABLED) {
    await auditLogger.initialize(config.AUDIT_LOG_DIR, config.AGENT_ID);
    auditLogger.authEvent('agent_startup', 'success', {
      agentId: config.AGENT_ID,
      agentName: config.AGENT_NAME,
      version: config.AGENT_VERSION,
      features: {
        runner: config.ENABLE_RUNNER,
        git: config.ENABLE_GIT,
        docker: config.ENABLE_DOCKER,
        httpFetch: config.ENABLE_HTTP_FETCH,
        systemTools: config.ENABLE_SYSTEM_TOOLS,
        unrestrictedMode: config.ENABLE_UNRESTRICTED_MODE,
      },
    });
  }

  logger.info(
    {
      agentId: config.AGENT_ID,
      agentName: config.AGENT_NAME,
      repoRoots: config.REPO_ROOTS_JSON,
      features: {
        runner: config.ENABLE_RUNNER,
        git: config.ENABLE_GIT,
        docker: config.ENABLE_DOCKER,
        httpFetch: config.ENABLE_HTTP_FETCH,
        systemTools: config.ENABLE_SYSTEM_TOOLS,
        unrestrictedMode: config.ENABLE_UNRESTRICTED_MODE,
      },
    },
    'Agent starting'
  );

  // Initialize tool registry
  const registry = createRegistry();

  // Register repo tools
  registry.register(
    createListTreeTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES, config.MAX_TREE_ENTRIES)
  );
  registry.register(
    createReadFileTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES, config.MAX_FILE_BYTES)
  );
  registry.register(
    createSearchRgTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES, config.MAX_SEARCH_MATCHES)
  );

  // Register git tools (if enabled)
  if (config.ENABLE_GIT) {
    registry.register(createGitStatusTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES));
    registry.register(createGitDiffTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES));
    registry.register(createGitShowTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES));
  }

  // Register runner tool (if enabled)
  if (config.ENABLE_RUNNER) {
    registry.register(
      createExecTool(
        config.REPO_ROOTS_JSON,
        config.MAX_OUTPUT_BYTES,
        config.RUNNER_ALLOWLIST_JSON,
        config.RUNNER_CWD,
        config.RUNNER_TIMEOUT_MS,
        config.ENABLE_UNRESTRICTED_MODE
      )
    );
  }

  // Register logs tool
  registry.register(createTailFileTool(config.REPO_ROOTS_JSON, config.LOG_ROOTS_JSON, config.MAX_OUTPUT_BYTES));

  // Register docker tools (if enabled)
  if (config.ENABLE_DOCKER) {
    registry.register(createDockerPsTool(config.MAX_OUTPUT_BYTES, config.DOCKER_SOCKET_PATH));
    registry.register(createDockerLogsTool(config.MAX_OUTPUT_BYTES, config.DOCKER_SOCKET_PATH));
  }

  // Register HTTP fetch tool (if enabled)
  if (config.ENABLE_HTTP_FETCH) {
    registry.register(createFetchLocalTool(config.MAX_OUTPUT_BYTES, config.LOCAL_HTTP_ALLOWLIST_JSON));
  }

  // Register system management tools (if enabled)
  if (config.ENABLE_SYSTEM_TOOLS) {
    const fileOpsTool = createFileOpsTool(
      config.MAX_OUTPUT_BYTES,
      config.RUNNER_TIMEOUT_MS,
      config.ENABLE_UNRESTRICTED_MODE
    );
    if (fileOpsTool) registry.register(fileOpsTool);

    const processTool = createProcessTool(
      config.MAX_OUTPUT_BYTES,
      config.RUNNER_TIMEOUT_MS,
      config.ENABLE_UNRESTRICTED_MODE
    );
    if (processTool) registry.register(processTool);

    const serviceTool = createServiceTool(
      config.MAX_OUTPUT_BYTES,
      config.RUNNER_TIMEOUT_MS,
      config.ENABLE_UNRESTRICTED_MODE
    );
    if (serviceTool) registry.register(serviceTool);

    const systemInfoTool = createSystemInfoTool(
      config.MAX_OUTPUT_BYTES,
      config.RUNNER_TIMEOUT_MS,
      config.ENABLE_UNRESTRICTED_MODE
    );
    if (systemInfoTool) registry.register(systemInfoTool);

    // Always register capabilities tool for transparency
    const capabilitiesTool = createCapabilitiesTool(
      config.MAX_FILE_BYTES,
      config.MAX_OUTPUT_BYTES,
      config.MAX_SEARCH_MATCHES,
      config.MAX_TREE_ENTRIES,
      config.RUNNER_TIMEOUT_MS,
      config.ENABLE_UNRESTRICTED_MODE,
      config.ENABLE_DOCKER,
      config.ENABLE_GIT,
      config.ENABLE_HTTP_FETCH,
      config.REPO_ROOTS_JSON
    );
    registry.register(capabilitiesTool);
  }

  // Register database tools (if enabled)
  if (config.ENABLE_DATABASE) {
    const dbQueryTool = createDbQueryTool(config.MAX_OUTPUT_BYTES);
    if (dbQueryTool) registry.register(dbQueryTool);
    registry.register(createDbListTool());
  }

  // Register Kubernetes tools (if enabled)
  if (config.ENABLE_KUBERNETES) {
    registry.register(createK8sPodsTool(config.MAX_OUTPUT_BYTES));
    registry.register(createK8sLogsTool(config.MAX_OUTPUT_BYTES));
    registry.register(createK8sDescribeTool(config.MAX_OUTPUT_BYTES));
    registry.register(createK8sEventsTool(config.MAX_OUTPUT_BYTES));
  }

  // Register network tools (if enabled)
  if (config.ENABLE_NETWORK) {
    registry.register(createNetPortsTool(config.MAX_OUTPUT_BYTES));
    registry.register(createNetDnsTool(config.MAX_OUTPUT_BYTES));
    registry.register(createNetPingTool(config.MAX_OUTPUT_BYTES));
    registry.register(createNetCurlTool(config.MAX_OUTPUT_BYTES));
  }

  // Register MCP Proxy tools (if enabled)
  if (config.ENABLE_MCP_PROXY) {
    registry.register(createMcpDiscoverTool(config.MAX_OUTPUT_BYTES));
    registry.register(createMcpCallTool(config.MAX_OUTPUT_BYTES));
    registry.register(createMcpListToolsTool(config.MAX_OUTPUT_BYTES));
  }

  // Register CLI tools (if enabled)
  if (config.ENABLE_CLI_TOOLS) {
    registry.register(createGeminiTool(config.MAX_OUTPUT_BYTES));
    registry.register(createCopilotTool(config.MAX_OUTPUT_BYTES));
    registry.register(createSessionStartTool(config.MAX_OUTPUT_BYTES));
    registry.register(createSessionInputTool(config.MAX_OUTPUT_BYTES));
    registry.register(createSessionReadTool(config.MAX_OUTPUT_BYTES));
    registry.register(createSessionStopTool());
    registry.register(createSessionListTool());
  }


  // Plugin loading
  const pluginLoader = new PluginLoader();
  const plugins = await pluginLoader.loadAll();

  for (const { plugin } of plugins) {
    await plugin.register(registry, config);
    logger.info(
      { pluginId: plugin.manifest.id, version: plugin.manifest.version },
      'Plugin registered'
    );
  }

  logger.info({ toolCount: registry.getNames().length }, 'Tools registered');
  logger.debug({ tools: registry.getNames() }, 'Registered tools');

  // Initialize dashboard (if enabled)
  if (config.DASHBOARD_ENABLED) {
    const dashboard = new DashboardServer({
      port: config.DASHBOARD_PORT,
      config,
      toolRegistry: registry,
    });
    dashboard.listen(config.DASHBOARD_PORT);
    logger.info({ port: config.DASHBOARD_PORT }, 'Dashboard server started');
  }

  // Initialize concurrency controller
  const concurrency = new ConcurrencyController(config.WS_MAX_CONCURRENT_CALLS);

  // Initialize WebSocket client
  const wsClient = new WSClient(
    {
      url: config.GATEWAY_WS_URL,
      agentId: config.AGENT_ID,
      agentKey: config.AGENT_KEY,
      pingInterval: config.WS_PING_INTERVAL_MS,
      reconnectMaxMs: config.WS_RECONNECT_MAX_MS,
    },
    registry,
    concurrency,
    async () => {
      // Message handler (reserved for future use)
    }
  );

  // Setup signal handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await wsClient.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Connect and start
  try {
    await wsClient.connect(config);
    logger.info('Agent started successfully');
  } catch (e) {
    logger.error({ error: String(e) }, 'Failed to start agent');
    process.exit(1);
  }
}

main().catch((e) => {
  logger.error({ error: String(e) }, 'Fatal error');
  process.exit(1);
});
