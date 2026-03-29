import { ToolExecutionError, PolicyDeniedError, ToolNotFoundError, ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';

// Database connection schema
const DatabaseConnectionSchema = z.object({
    name: z.string(),
    type: z.enum(['postgres', 'mysql', 'sqlite']),
    url: z.string(),
    readonly: z.boolean().default(true),
});

type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

// Parse connections from env
function parseConnections(): DatabaseConnection[] {
    const json = process.env.DATABASE_CONNECTIONS_JSON;
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return z.array(DatabaseConnectionSchema).parse(parsed);
    } catch (e: unknown) {
        logger.warn({ error: String(e) }, 'Failed to parse DATABASE_CONNECTIONS_JSON');
        return [];
    }
}

// SQL safety check - only allow read-only operations
function isSafeQuery(sql: string): { safe: boolean; reason?: string } {
    const normalized = sql.trim().toUpperCase();

    // Forbidden keywords for readonly mode
    const forbidden = [
        'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE',
        'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'CALL', 'INTO OUTFILE',
        'INTO DUMPFILE', 'LOAD_FILE', 'LOAD DATA', 'REPLACE'
    ];

    for (const keyword of forbidden) {
        // Check if keyword is at start or after whitespace/semicolon
        const regex = new RegExp(`(^|[\\s;])${keyword}(\\s|$|;)`, 'i');
        if (regex.test(normalized)) {
            return { safe: false, reason: `Forbidden keyword: ${keyword}` };
        }
    }

    // Must start with SELECT, WITH, SHOW, DESCRIBE, EXPLAIN
    const allowedStart = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'DESC'];
    const startsWithAllowed = allowedStart.some(kw => normalized.startsWith(kw));

    if (!startsWithAllowed) {
        return { safe: false, reason: 'Query must start with SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN' };
    }

    return { safe: true };
}

const DbQueryArgsSchema = z.object({
    connection: z.string().describe('Connection name from DATABASE_CONNECTIONS_JSON'),
    sql: z.string().describe('SQL query to execute (SELECT only)'),
    limit: z.number().int().positive().max(1000).default(100).describe('Max rows to return'),
});

const DbListArgsSchema = z.object({});

export function createDbQueryTool(
    maxOutputBytes: number,
    maxRows: number = 1000
) {
    const connections = parseConnections();

    if (connections.length === 0) {
        logger.debug('No database connections configured, db.query tool disabled');
        return null;
    }

    return createTool(
        'db.query',
        `🗄️ DATABASE QUERY (Read-Only)

Execute SQL queries on configured databases.

AVAILABLE CONNECTIONS:
${connections.map(c => `• ${c.name} (${c.type})`).join('\n')}

PARAMETERS:
• connection: Connection name (see above)
• sql: SQL query (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN only)
• limit: Max rows to return (default: 100, max: ${maxRows})

EXAMPLES:
1. Simple select:
   {"connection": "prod", "sql": "SELECT * FROM users LIMIT 10"}

2. Join query:
   {"connection": "prod", "sql": "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id LIMIT 50"}

3. Count:
   {"connection": "prod", "sql": "SELECT COUNT(*) FROM orders WHERE status = 'pending'"}

4. Table info (PostgreSQL):
   {"connection": "prod", "sql": "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'"}

RESTRICTIONS:
• Read-only: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER are blocked
• Results limited to ${maxRows} rows max
• Timeout: 30 seconds

BEST PRACTICES:
• Always use LIMIT clause
• Use specific columns instead of SELECT *
• Check db.list first for available connections`,
        DbQueryArgsSchema,
        async (args) => {
            const parsed = DbQueryArgsSchema.parse(args);
            const connections = parseConnections();

            const conn = connections.find(c => c.name === parsed.connection);
            if (!conn) {
                throw new ToolNotFoundError(`Connection not found: ${parsed.connection}. Available: ${connections.map(c => c.name).join(', ')}`);
            }

            // Safety check
            if (conn.readonly) {
                const safety = isSafeQuery(parsed.sql);
                if (!safety.safe) {
                    throw new PolicyDeniedError(`Query rejected: ${safety.reason}`, 'db.query');
                }
            }

            try {
                let result: string;

                if (conn.type === 'postgres') {
                    result = await executePostgres(conn.url, parsed.sql, Math.min(parsed.limit, maxRows));
                } else if (conn.type === 'mysql') {
                    result = await executeMysql(conn.url, parsed.sql, Math.min(parsed.limit, maxRows));
                } else if (conn.type === 'sqlite') {
                    result = await executeSqlite(conn.url, parsed.sql, Math.min(parsed.limit, maxRows));
                } else {
                    throw new ToolValidationError('db.query', [`Unsupported database type: ${conn.type}`]);
                }

                const truncated = truncateOutput(result, maxOutputBytes);

                return {
                    content: [{ type: 'text', text: truncated }],
                };
            } catch (e: unknown) {
                logger.warn({ connection: parsed.connection, error: String(e) }, 'db.query failed');
                throw new ToolExecutionError('db.query', e);
            }
        }
    );
}

export function createDbListTool() {
    const connections = parseConnections();

    return createTool(
        'db.list',
        `📋 LIST DATABASE CONNECTIONS

Show all configured database connections.

PARAMETERS: none

RETURNS:
• Connection name
• Database type
• Readonly status`,
        DbListArgsSchema,
        async () => {
            const connections = parseConnections();

            if (connections.length === 0) {
                return {
                    content: [{ type: 'text', text: 'No database connections configured.\n\nTo configure, set DATABASE_CONNECTIONS_JSON environment variable.' }],
                };
            }

            const lines = connections.map(c =>
                `• ${c.name}: ${c.type} (${c.readonly ? 'read-only' : 'read-write'})`
            );

            return {
                content: [{ type: 'text', text: `Available connections:\n${lines.join('\n')}` }],
            };
        }
    );
}

// Database execution helpers using shell commands (no native drivers needed)
async function executePostgres(url: string, sql: string, limit: number): Promise<string> {
    const { execa } = await import('execa');

    // Append LIMIT if not present
    const limitedSql = sql.toUpperCase().includes('LIMIT') ? sql : `${sql} LIMIT ${limit}`;

    try {
        const result = await execa('psql', [url, '-c', limitedSql, '-P', 'format=aligned'], {
            timeout: 30000,
            reject: false,
        });

        if (result.exitCode !== 0) {
            throw new ToolExecutionError('db.query', result.stderr || 'psql command failed');
        }

        return result.stdout;
    } catch (e: unknown) {
        // Fallback message if psql not available
        if (String(e).includes('ENOENT')) {
            throw new ToolExecutionError('db.query', 'psql command not found. Install PostgreSQL client or use native driver.');
        }
        throw e;
    }
}

async function executeMysql(url: string, sql: string, limit: number): Promise<string> {
    const { execa } = await import('execa');

    // Parse URL: mysql://user:pass@host:port/database
    const urlObj = new URL(url);
    const host = urlObj.hostname;
    const port = urlObj.port || '3306';
    const user = urlObj.username;
    const pass = urlObj.password;
    const database = urlObj.pathname.slice(1);

    const limitedSql = sql.toUpperCase().includes('LIMIT') ? sql : `${sql} LIMIT ${limit}`;

    try {
        const args = [
            `-h${host}`,
            `-P${port}`,
            `-u${user}`,
            database,
            '-e', limitedSql,
        ];

        const result = await execa('mysql', args, {
            timeout: 30000,
            reject: false,
            env: { ...process.env, MYSQL_PWD: pass },
        });

        if (result.exitCode !== 0) {
            throw new ToolExecutionError('db.query', result.stderr || 'mysql command failed');
        }

        return result.stdout;
    } catch (e: unknown) {
        if (String(e).includes('ENOENT')) {
            throw new ToolExecutionError('db.query', 'mysql command not found. Install MySQL client.');
        }
        throw e;
    }
}

async function executeSqlite(dbPath: string, sql: string, limit: number): Promise<string> {
    const { execa } = await import('execa');

    const limitedSql = sql.toUpperCase().includes('LIMIT') ? sql : `${sql} LIMIT ${limit}`;

    try {
        const result = await execa('sqlite3', [dbPath, '-header', '-column', limitedSql], {
            timeout: 30000,
            reject: false,
        });

        if (result.exitCode !== 0) {
            throw new ToolExecutionError('db.query', result.stderr || 'sqlite3 command failed');
        }

        return result.stdout;
    } catch (e: unknown) {
        if (String(e).includes('ENOENT')) {
            throw new ToolExecutionError('db.query', 'sqlite3 command not found. Install SQLite.');
        }
        throw e;
    }
}
