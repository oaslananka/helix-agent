import express from 'express';
import cors from 'cors';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createReadStream, existsSync, statSync } from 'fs';
import { Config } from '../config/env.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Server } from 'http';
import { auditLogger } from '../security/auditLogger.js';
import { runtimeConfig } from '../config/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DashboardConfig {
  port: number;
  config: Config;
  toolRegistry: ToolRegistry;
}

export class DashboardServer {
  private app: express.Application;
  private server: Server | null = null;
  private wss: WebSocketServer;
  private config: Config;
  private toolRegistry: ToolRegistry;
  private logWatchers: Set<WebSocket> = new Set();

  constructor(dashboardConfig: DashboardConfig) {
    this.app = express();
    this.config = dashboardConfig.config;
    this.toolRegistry = dashboardConfig.toolRegistry;
    
    this.setupMiddleware();
    this.setupRoutes();
    
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws/logs' });
    this.setupWebSocket();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Auth middleware for control endpoints
    this.app.use('/api/control', (req, res, next) => {
      const token = req.headers['x-auth-token'] || req.query.token;
      
      // If no auth token configured, allow all
      if (!this.config.DASHBOARD_AUTH_TOKEN) {
        return next();
      }
      
      if (token !== this.config.DASHBOARD_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      next();
    });
  }

  private setupRoutes(): void {
    // Dashboard HTML
    this.app.get('/', (req, res) => {
      res.send(this.getDashboardHTML());
    });

    // Agent status (read from process.env for runtime updates)
    this.app.get('/api/status', (req, res) => {
      res.json({
        agentId: this.config.AGENT_ID,
        agentName: this.config.AGENT_NAME,
        version: this.config.AGENT_VERSION,
        connected: true, // TODO: Get from WSClient
        uptime: process.uptime(),
        tools: this.toolRegistry.getNames(),
        toolCount: this.toolRegistry.getNames().length,
        features: {
          runner: process.env.ENABLE_RUNNER === 'true',
          git: process.env.ENABLE_GIT === 'true',
          docker: process.env.ENABLE_DOCKER === 'true',
          httpFetch: process.env.ENABLE_HTTP_FETCH === 'true',
          systemTools: process.env.ENABLE_SYSTEM_TOOLS === 'true',
          unrestrictedMode: process.env.ENABLE_UNRESTRICTED_MODE === 'true',
          auditLog: process.env.AUDIT_LOG_ENABLED === 'true',
        },
        memory: process.memoryUsage(),
      });
    });

    // Config (read from process.env for runtime updates)
    this.app.get('/api/config', (req, res) => {
      res.json({
        AGENT_ID: this.config.AGENT_ID,
        AGENT_NAME: this.config.AGENT_NAME,
        AGENT_VERSION: this.config.AGENT_VERSION,
        REPO_ROOTS: this.config.REPO_ROOTS_JSON,
        LOG_LEVEL: this.config.LOG_LEVEL,
        MAX_OUTPUT_BYTES: this.config.MAX_OUTPUT_BYTES,
        MAX_FILE_BYTES: this.config.MAX_FILE_BYTES,
        WS_PING_INTERVAL_MS: this.config.WS_PING_INTERVAL_MS,
        ENABLE_RUNNER: process.env.ENABLE_RUNNER === 'true',
        ENABLE_GIT: process.env.ENABLE_GIT === 'true',
        ENABLE_DOCKER: process.env.ENABLE_DOCKER === 'true',
        ENABLE_HTTP_FETCH: process.env.ENABLE_HTTP_FETCH === 'true',
        ENABLE_SYSTEM_TOOLS: process.env.ENABLE_SYSTEM_TOOLS === 'true',
        ENABLE_UNRESTRICTED_MODE: process.env.ENABLE_UNRESTRICTED_MODE === 'true',
        AUDIT_LOG_ENABLED: process.env.AUDIT_LOG_ENABLED === 'true',
        AUDIT_LOG_DIR: this.config.AUDIT_LOG_DIR,
      });
    });

    // Audit logs
    this.app.get('/api/logs/audit', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const logPath = join(this.config.AUDIT_LOG_DIR, 'audit.log');
        
        if (!existsSync(logPath)) {
          return res.json([]);
        }

        const content = await readFile(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.length > 0);
        const logs = lines
          .slice(-limit)
          .map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(l => l !== null)
          .reverse();

        res.json(logs);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Agent logs
    this.app.get('/api/logs/agent', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const logPath = join(this.config.AUDIT_LOG_DIR, 'agent.log');
        
        if (!existsSync(logPath)) {
          return res.json([]);
        }

        const content = await readFile(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.length > 0);
        const logs = lines
          .slice(-limit)
          .map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(l => l !== null)
          .reverse();

        res.json(logs);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Log files list
    this.app.get('/api/logs/files', async (req, res) => {
      try {
        const files = await readdir(this.config.AUDIT_LOG_DIR);
        const fileStats = await Promise.all(
          files.map(async (file) => {
            const filePath = join(this.config.AUDIT_LOG_DIR, file);
            const stats = statSync(filePath);
            return {
              name: file,
              size: stats.size,
              modified: stats.mtime,
            };
          })
        );
        res.json(fileStats);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Download log file
    this.app.get('/api/logs/download/:filename', (req, res) => {
      try {
        const filename = req.params.filename;
        const filePath = join(this.config.AUDIT_LOG_DIR, filename);
        
        if (!existsSync(filePath) || !filename.endsWith('.log') && !filename.endsWith('.gz')) {
          return res.status(404).json({ error: 'File not found' });
        }

        res.download(filePath);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    // Control endpoints (protected by auth middleware)
    // Update feature toggle
    this.app.post('/api/control/feature/:featureName', async (req, res) => {
      try {
        const { featureName } = req.params;
        const { enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'enabled must be boolean' });
        }

        // Update environment variable
        const envMap: Record<string, string> = {
          'runner': 'ENABLE_RUNNER',
          'git': 'ENABLE_GIT',
          'docker': 'ENABLE_DOCKER',
          'httpFetch': 'ENABLE_HTTP_FETCH',
          'systemTools': 'ENABLE_SYSTEM_TOOLS',
          'unrestrictedMode': 'ENABLE_UNRESTRICTED_MODE',
          'auditLog': 'AUDIT_LOG_ENABLED',
        };

        const envKey = envMap[featureName];
        if (!envKey) {
          return res.status(400).json({ error: 'Invalid feature name' });
        }

        const newValue = enabled ? 'true' : 'false';
        
        // Save to runtime config (persists across restarts)
        await runtimeConfig.save(envKey, newValue);
        
        auditLogger.systemOperation('dashboard.feature_toggle', {
          feature: featureName,
          enabled,
          envKey,
          persisted: true,
        }, 'success');

        res.json({ 
          success: true, 
          feature: featureName, 
          enabled,
          message: 'Feature updated and saved! Restart to apply changes.',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Update config value
    this.app.post('/api/control/config', async (req, res) => {
      try {
        const { key, value } = req.body;
        
        if (!key || value === undefined) {
          return res.status(400).json({ error: 'key and value required' });
        }

        // Save to runtime config (persists across restarts)
        await runtimeConfig.save(key, String(value));
        
        auditLogger.systemOperation('dashboard.config_update', {
          key,
          value: typeof value === 'string' && value.length > 50 ? '[TRUNCATED]' : value,
          persisted: true,
        }, 'success');

        res.json({ 
          success: true, 
          key, 
          message: 'Config updated and saved! Restart to apply changes.',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Tool management
    this.app.post('/api/control/tool/:toolName', async (req, res) => {
      try {
        const { toolName } = req.params;
        const { action } = req.body; // 'enable' or 'disable'
        
        if (!['enable', 'disable'].includes(action)) {
          return res.status(400).json({ error: 'action must be enable or disable' });
        }

        // TODO: Implement tool registry enable/disable
        auditLogger.systemOperation('dashboard.tool_control', {
          toolName,
          action,
        }, 'success');

        res.json({ 
          success: true, 
          toolName, 
          action,
          message: 'Tool control not fully implemented yet',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // Restart agent (exit with code 0, Docker will restart)
    this.app.post('/api/control/restart', async (req, res) => {
      try {
        auditLogger.systemOperation('dashboard.restart_request', {
          requestedBy: req.ip,
        }, 'success');

        res.json({ 
          success: true, 
          message: 'Agent will restart in 2 seconds',
        });

        // Give time for response to be sent
        setTimeout(() => {
          console.log('Restarting agent by dashboard request...');
          process.exit(0);
        }, 2000);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      console.log('Dashboard WebSocket client connected');
      this.logWatchers.add(ws);

      ws.on('close', () => {
        console.log('Dashboard WebSocket client disconnected');
        this.logWatchers.delete(ws);
      });

      // Send initial message
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to log stream',
      }));
    });
  }

  /**
   * Broadcast log entry to all connected WebSocket clients
   */
  broadcastLog(logEntry: Record<string, unknown>): void {
    const message = JSON.stringify({
      type: 'log',
      data: logEntry,
    });

    this.logWatchers.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  listen(port: number): void {
    this.server?.listen(port, () => {
      console.log(`Dashboard server running at http://localhost:${port}`);
      auditLogger.audit({
        eventType: 'system_operation',
        operation: 'dashboard_started',
        result: 'success',
        metadata: { port },
      });
    });
  }

  private getDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Helix Agent Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            padding: 20px;
            min-height: 100vh;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        .header {
            background: white;
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }

        .header h1 {
            font-size: 2.5em;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
        }

        .status-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
            margin-right: 10px;
        }

        .status-badge.online {
            background: #10b981;
            color: white;
        }

        .status-badge.unrestricted {
            background: #ef4444;
            color: white;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: white;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }

        .card h2 {
            font-size: 1.3em;
            margin-bottom: 15px;
            color: #667eea;
        }

        .stat {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .stat:last-child {
            border-bottom: none;
        }

        .stat-label {
            font-weight: 600;
            color: #666;
        }

        .stat-value {
            color: #333;
            font-weight: 500;
        }

        .log-container {
            background: white;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            max-height: 600px;
            overflow-y: auto;
        }

        .log-entry {
            padding: 12px;
            margin-bottom: 8px;
            border-radius: 8px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 0.85em;
            border-left: 4px solid #667eea;
            background: #f8f9fa;
        }

        .log-entry.error {
            border-left-color: #ef4444;
            background: #fee;
        }

        .log-entry.warn {
            border-left-color: #f59e0b;
            background: #fff3cd;
        }

        .log-entry.audit {
            border-left-color: #8b5cf6;
            background: #f5f3ff;
        }

        .log-time {
            color: #666;
            font-size: 0.9em;
            margin-right: 10px;
        }

        .log-level {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            font-weight: 600;
            margin-right: 8px;
        }

        .log-level.info {
            background: #3b82f6;
            color: white;
        }

        .log-level.warn {
            background: #f59e0b;
            color: white;
        }

        .log-level.error {
            background: #ef4444;
            color: white;
        }

        .tool-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .tool-tag {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 500;
        }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .tab {
            padding: 10px 20px;
            background: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s;
        }

        .tab.active {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .tab:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .filter-controls {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }

        .filter-controls select,
        .filter-controls input {
            padding: 8px 12px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 0.9em;
        }

        .btn {
            padding: 10px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }

        .feature-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 15px;
            font-size: 0.8em;
            font-weight: 600;
            margin: 2px;
        }

        .feature-badge.enabled {
            background: #10b981;
            color: white;
        }

        .feature-badge.disabled {
            background: #6b7280;
            color: white;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .live-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            background: #10b981;
            border-radius: 50%;
            margin-left: 10px;
            animation: pulse 2s ease-in-out infinite;
        }

        /* Toggle Switch CSS */
        input[type="checkbox"]:checked + span {
            background-color: #10b981 !important;
        }

        input[type="checkbox"]:checked + span span {
            transform: translateX(30px);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Helix Agent Dashboard</h1>
            <div>
                <span class="status-badge online" id="statusBadge">● ONLINE</span>
                <span class="status-badge unrestricted" id="unrestrictedBadge" style="display:none">⚠️ UNRESTRICTED MODE</span>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h2>📊 Agent Info</h2>
                <div class="stat">
                    <span class="stat-label">Agent ID:</span>
                    <span class="stat-value" id="agentId">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Agent Name:</span>
                    <span class="stat-value" id="agentName">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Version:</span>
                    <span class="stat-value" id="version">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Uptime:</span>
                    <span class="stat-value" id="uptime">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Tools:</span>
                    <span class="stat-value" id="toolCount">-</span>
                </div>
            </div>

            <div class="card">
                <h2>💾 Memory Usage</h2>
                <div class="stat">
                    <span class="stat-label">RSS:</span>
                    <span class="stat-value" id="memRss">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Heap Used:</span>
                    <span class="stat-value" id="memHeapUsed">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Heap Total:</span>
                    <span class="stat-value" id="memHeapTotal">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">External:</span>
                    <span class="stat-value" id="memExternal">-</span>
                </div>
            </div>

            <div class="card">
                <h2>⚙️ Features</h2>
                <div id="features"></div>
            </div>
        </div>

        <div class="card">
            <h2>🛠️ Registered Tools</h2>
            <div class="tool-list" id="toolList"></div>
        </div>

        <div style="margin-top: 20px;">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('audit')">🔒 Audit Logs</button>
                <button class="tab" onclick="switchTab('agent')">📝 Agent Logs</button>
                <button class="tab" onclick="switchTab('live')">📡 Live Stream <span class="live-indicator"></span></button>
                <button class="tab" onclick="switchTab('settings')">⚙️ Settings</button>
            </div>

            <div id="tabContent">
                <div id="logsTab">
                    <div class="filter-controls">
                        <select id="filterLevel" onchange="applyFilters()">
                            <option value="">All Levels</option>
                            <option value="info">Info</option>
                            <option value="warn">Warn</option>
                            <option value="error">Error</option>
                        </select>
                        <select id="filterType" onchange="applyFilters()">
                            <option value="">All Types</option>
                            <option value="tool_call">Tool Calls</option>
                            <option value="system_operation">System Ops</option>
                            <option value="security_violation">Security</option>
                            <option value="auth">Auth</option>
                        </select>
                        <input type="text" id="filterSearch" placeholder="Search..." oninput="applyFilters()">
                        <button class="btn" onclick="refreshLogs()">🔄 Refresh</button>
                        <button class="btn" onclick="clearLogs()">🗑️ Clear</button>
                    </div>

                    <div class="log-container" id="logContainer"></div>
                </div>

                <div id="settingsTab" style="display:none;">
                    <div class="card" style="margin-bottom: 20px;">
                        <h2>🔐 Authentication</h2>
                        <div class="stat">
                            <span class="stat-label">Auth Token:</span>
                            <input type="password" id="authToken" placeholder="Enter auth token (if required)" style="width: 300px; padding: 8px; border: 2px solid #e5e7eb; border-radius: 8px;">
                            <button class="btn" onclick="saveAuthToken()" style="margin-left: 10px;">💾 Save</button>
                        </div>
                        <p style="margin-top: 10px; color: #6b7280; font-size: 0.9em;">If DASHBOARD_AUTH_TOKEN is set, you must provide it to use control features.</p>
                    </div>

                    <div class="card" style="margin-bottom: 20px;">
                        <h2>🎛️ Feature Toggles</h2>
                        <p style="margin-bottom: 15px; color: #6b7280;">Changes require agent restart to take effect.</p>
                        <div id="featureToggles"></div>
                    </div>

                    <div class="card" style="margin-bottom: 20px;">
                        <h2>🔄 Agent Control</h2>
                        <button class="btn" onclick="restartAgent()" style="background: #ef4444; margin-right: 10px;">🔄 Restart Agent</button>
                        <p style="margin-top: 10px; color: #6b7280; font-size: 0.9em;">Docker will automatically restart the agent container.</p>
                    </div>

                    <div class="card">
                        <h2>📋 Configuration</h2>
                        <div id="configEditor"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentTab = 'audit';
        let ws = null;
        let allLogs = [];
        let filteredLogs = [];

        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        }

        function formatUptime(seconds) {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            
            let result = [];
            if (days > 0) result.push(\`\${days}d\`);
            if (hours > 0) result.push(\`\${hours}h\`);
            if (minutes > 0) result.push(\`\${minutes}m\`);
            result.push(\`\${secs}s\`);
            
            return result.join(' ');
        }

        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                document.getElementById('agentId').textContent = data.agentId;
                document.getElementById('agentName').textContent = data.agentName;
                document.getElementById('version').textContent = data.version;
                document.getElementById('uptime').textContent = formatUptime(data.uptime);
                document.getElementById('toolCount').textContent = data.toolCount;
                
                document.getElementById('memRss').textContent = formatBytes(data.memory.rss);
                document.getElementById('memHeapUsed').textContent = formatBytes(data.memory.heapUsed);
                document.getElementById('memHeapTotal').textContent = formatBytes(data.memory.heapTotal);
                document.getElementById('memExternal').textContent = formatBytes(data.memory.external);
                
                // Features
                const featuresDiv = document.getElementById('features');
                featuresDiv.innerHTML = Object.entries(data.features)
                    .map(([key, value]) => {
                        const enabled = value ? 'enabled' : 'disabled';
                        const label = key.replace(/([A-Z])/g, ' $1').trim();
                        return \`<span class="feature-badge \${enabled}">\${label}</span>\`;
                    })
                    .join('');
                
                // Show unrestricted badge
                if (data.features.unrestrictedMode) {
                    document.getElementById('unrestrictedBadge').style.display = 'inline-block';
                }
                
                // Tools
                const toolListDiv = document.getElementById('toolList');
                toolListDiv.innerHTML = data.tools
                    .map(tool => \`<span class="tool-tag">\${tool}</span>\`)
                    .join('');
                    
            } catch (e) {
                console.error('Failed to load status:', e);
            }
        }

        async function loadLogs(type) {
            try {
                const response = await fetch(\`/api/logs/\${type}?limit=200\`);
                allLogs = await response.json();
                filteredLogs = allLogs;
                applyFilters();
            } catch (e) {
                console.error('Failed to load logs:', e);
            }
        }

        function renderLogs() {
            const container = document.getElementById('logContainer');
            
            if (filteredLogs.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:#666;padding:40px;">No logs found</div>';
                return;
            }
            
            container.innerHTML = filteredLogs.map(log => {
                const level = log.level || 'info';
                const time = new Date(log.time).toLocaleString();
                const isAudit = log.audit === true;
                const className = isAudit ? 'audit' : (level === 'error' ? 'error' : level === 'warn' ? 'warn' : '');
                
                let content = log.msg || '';
                if (log.eventType) {
                    content = \`[\${log.eventType}] \${log.operation || ''} - \${log.result || ''}\`;
                }
                if (log.error) {
                    content += \` | Error: \${log.error}\`;
                }
                
                return \`
                    <div class="log-entry \${className}">
                        <span class="log-time">\${time}</span>
                        <span class="log-level \${level}">\${level.toUpperCase()}</span>
                        \${content}
                        \${log.toolName ? \`<br><small>Tool: \${log.toolName}</small>\` : ''}
                        \${log.duration ? \`<small> | Duration: \${log.duration}ms</small>\` : ''}
                    </div>
                \`;
            }).join('');
            
            container.scrollTop = 0;
        }

        function applyFilters() {
            const levelFilter = document.getElementById('filterLevel').value;
            const typeFilter = document.getElementById('filterType').value;
            const searchFilter = document.getElementById('filterSearch').value.toLowerCase();
            
            filteredLogs = allLogs.filter(log => {
                if (levelFilter && log.level !== levelFilter) return false;
                if (typeFilter && log.eventType !== typeFilter) return false;
                if (searchFilter) {
                    const searchText = JSON.stringify(log).toLowerCase();
                    if (!searchText.includes(searchFilter)) return false;
                }
                return true;
            });
            
            renderLogs();
        }

        function switchTab(tab) {
            currentTab = tab;
            
            // Update tab styles
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            
            // Show/hide content
            if (tab === 'settings') {
                document.getElementById('logsTab').style.display = 'none';
                document.getElementById('settingsTab').style.display = 'block';
                loadSettings();
            } else {
                document.getElementById('logsTab').style.display = 'block';
                document.getElementById('settingsTab').style.display = 'none';
                
                // Disconnect WebSocket if switching away from live
                if (ws) {
                    ws.close();
                    ws = null;
                }
                
                if (tab === 'live') {
                    connectLiveStream();
                } else {
                    loadLogs(tab);
                }
            }
        }

        function connectLiveStream() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws/logs\`);
            
            ws.onopen = () => {
                console.log('Connected to live stream');
                allLogs = [];
                filteredLogs = [];
                renderLogs();
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'log') {
                    allLogs.unshift(data.data);
                    if (allLogs.length > 200) allLogs = allLogs.slice(0, 200);
                    applyFilters();
                }
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            
            ws.onclose = () => {
                console.log('Disconnected from live stream');
            };
        }

        function refreshLogs() {
            if (currentTab === 'live') {
                connectLiveStream();
            } else {
                loadLogs(currentTab);
            }
        }

        function clearLogs() {
            allLogs = [];
            filteredLogs = [];
            renderLogs();
        }

        // Settings functions
        let authToken = '';

        function saveAuthToken() {
            authToken = document.getElementById('authToken').value;
            localStorage.setItem('dashboardAuthToken', authToken);
            alert('Auth token saved! It will be used for all control operations.');
        }

        function loadAuthToken() {
            authToken = localStorage.getItem('dashboardAuthToken') || '';
            if (authToken) {
                document.getElementById('authToken').value = authToken;
            }
        }

        async function loadSettings() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                // Load feature toggles
                const featuresDiv = document.getElementById('featureToggles');
                const features = {
                    'runner': 'Runner (Execute Commands)',
                    'git': 'Git Operations',
                    'docker': 'Docker Management',
                    'httpFetch': 'HTTP Fetch',
                    'systemTools': 'System Tools',
                    'unrestrictedMode': 'Unrestricted Mode (⚠️ DANGEROUS)',
                    'auditLog': 'Audit Logging',
                };
                
                featuresDiv.innerHTML = Object.entries(features).map(([key, label]) => {
                    const enabled = data.features[key] || false;
                    const dangerClass = key === 'unrestrictedMode' ? 'background: #ef4444;' : '';
                    
                    return \`
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid #e5e7eb;">
                            <span style="font-weight: 500;">\${label}</span>
                            <label style="position: relative; display: inline-block; width: 60px; height: 30px;">
                                <input type="checkbox" 
                                       id="toggle_\${key}" 
                                       onchange="toggleFeature('\${key}', this.checked)" 
                                       \${enabled ? 'checked' : ''}
                                       style="opacity: 0; width: 0; height: 0;">
                                <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; \${dangerClass} background-color: #ccc; transition: 0.4s; border-radius: 30px;">
                                    <span style="position: absolute; content: ''; height: 22px; width: 22px; left: 4px; bottom: 4px; background-color: white; transition: 0.4s; border-radius: 50%;"></span>
                                </span>
                            </label>
                        </div>
                    \`;
                }).join('');
                
                // Load config editor
                const configResponse = await fetch('/api/config');
                const configData = await configResponse.json();
                
                const configDiv = document.getElementById('configEditor');
                configDiv.innerHTML = Object.entries(configData)
                    .map(([key, value]) => {
                        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                        const isSensitive = key.includes('KEY') || key.includes('TOKEN');
                        
                        return \`
                            <div style="margin-bottom: 15px;">
                                <label style="display: block; font-weight: 500; margin-bottom: 5px;">\${key}</label>
                                <input type="\${isSensitive ? 'password' : 'text'}" 
                                       id="config_\${key}" 
                                       value="\${displayValue}"
                                       style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 8px; font-family: monospace; font-size: 0.9em;">
                            </div>
                        \`;
                    })
                    .join('');
                    
            } catch (e) {
                console.error('Failed to load settings:', e);
                alert('Failed to load settings: ' + e.message);
            }
        }

        async function toggleFeature(featureName, enabled) {
            try {
                const response = await fetch(\`/api/control/feature/\${featureName}\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Auth-Token': authToken
                    },
                    body: JSON.stringify({ enabled })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    alert('Error: ' + data.error);
                    // Revert toggle
                    document.getElementById(\`toggle_\${featureName}\`).checked = !enabled;
                    return;
                }
                
                alert(data.message || 'Feature updated successfully');
                
                if (featureName === 'unrestrictedMode') {
                    alert('⚠️ WARNING: Unrestricted mode ' + (enabled ? 'ENABLED' : 'DISABLED') + '!\\n\\nPlease restart the agent for changes to take effect.');
                }
            } catch (e) {
                console.error('Failed to toggle feature:', e);
                alert('Failed to toggle feature: ' + e.message);
                // Revert toggle
                document.getElementById(\`toggle_\${featureName}\`).checked = !enabled;
            }
        }

        async function restartAgent() {
            if (!confirm('Are you sure you want to restart the agent?\\n\\nThe agent will be unavailable for a few seconds.')) {
                return;
            }
            
            try {
                const response = await fetch('/api/control/restart', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Auth-Token': authToken
                    }
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    alert('Error: ' + data.error);
                    return;
                }
                
                alert('✅ Agent restart initiated!\\n\\nThe page will refresh in 5 seconds...');
                
                setTimeout(() => {
                    window.location.reload();
                }, 5000);
            } catch (e) {
                console.error('Failed to restart agent:', e);
                alert('Failed to restart agent: ' + e.message);
            }
        }

        // Initial load
        loadStatus();
        loadLogs('audit');
        loadAuthToken();
        
        // Refresh status every 5 seconds
        setInterval(loadStatus, 5000);
    </script>
</body>
</html>
    `;
  }
}
