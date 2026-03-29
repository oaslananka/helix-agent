import { ToolExecutionError, PolicyDeniedError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

// Parse allowed namespaces from env
function getAllowedNamespaces(): string[] {
    const json = process.env.K8S_ALLOWED_NAMESPACES_JSON;
    if (!json) return ['default'];
    try {
        return JSON.parse(json);
    } catch {
        return ['default'];
    }
}

function isNamespaceAllowed(namespace: string): boolean {
    const allowed = getAllowedNamespaces();
    // Empty array means all allowed
    if (allowed.length === 0) return true;
    return allowed.includes(namespace) || allowed.includes('*');
}

// Common kubectl execution
async function runKubectl(args: string[], timeout: number = 30000): Promise<string> {
    const kubeconfigPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;
    const env = kubeconfigPath ? { ...process.env, KUBECONFIG: kubeconfigPath } : process.env;

    try {
        const result = await execa('kubectl', args, {
            timeout,
            reject: false,
            env,
        });

        if (result.exitCode !== 0) {
            throw new ToolExecutionError('k8s', result.stderr || `kubectl failed with exit code ${result.exitCode}`);
        }

        return result.stdout;
    } catch (e: unknown) {
        if (String(e).includes('ENOENT')) {
            throw new ToolExecutionError('k8s', 'kubectl command not found. Install kubectl or check PATH.');
        }
        throw e;
    }
}

// K8s Pods Tool
const K8sPodsArgsSchema = z.object({
    namespace: z.string().default('default').describe('Kubernetes namespace'),
    selector: z.string().optional().describe('Label selector (e.g., app=nginx)'),
    allNamespaces: z.boolean().default(false).describe('List pods from all namespaces'),
});

export function createK8sPodsTool(maxOutputBytes: number) {
    return createTool(
        'k8s.pods',
        `☸️ KUBERNETES PODS

List pods in a Kubernetes cluster.

ALLOWED NAMESPACES: ${getAllowedNamespaces().join(', ') || 'all'}

PARAMETERS:
• namespace: Namespace to list pods from (default: default)
• selector: Label selector filter (optional, e.g., "app=nginx")
• allNamespaces: List from all namespaces (default: false)

EXAMPLES:
1. List pods in default namespace:
   {"namespace": "default"}

2. List pods with label selector:
   {"namespace": "production", "selector": "app=web"}

3. List all pods across namespaces:
   {"allNamespaces": true}

OUTPUT INCLUDES:
• Pod name
• Ready status
• Status (Running/Pending/Failed)
• Restarts
• Age

BEST PRACTICES:
• Use k8s.pods before k8s.logs to get pod names
• Check restarts for crash issues`,
        K8sPodsArgsSchema,
        async (args) => {
            const parsed = K8sPodsArgsSchema.parse(args);

            if (!parsed.allNamespaces && !isNamespaceAllowed(parsed.namespace)) {
                throw new PolicyDeniedError(`Namespace not allowed: ${parsed.namespace}. Allowed: ${getAllowedNamespaces().join(', ')}`, 'k8s');
            }

            const kubectlArgs = ['get', 'pods', '-o', 'wide'];

            if (parsed.allNamespaces) {
                kubectlArgs.push('--all-namespaces');
            } else {
                kubectlArgs.push('-n', parsed.namespace);
            }

            if (parsed.selector) {
                kubectlArgs.push('-l', parsed.selector);
            }

            try {
                const output = await runKubectl(kubectlArgs);
                const truncated = truncateOutput(output, maxOutputBytes);

                return {
                    content: [{ type: 'text', text: truncated }],
                };
            } catch (e: unknown) {
                logger.warn({ error: String(e) }, 'k8s.pods failed');
                throw new ToolExecutionError('k8s.pods', e);
            }
        }
    );
}

// K8s Logs Tool
const K8sLogsArgsSchema = z.object({
    pod: z.string().describe('Pod name'),
    namespace: z.string().default('default'),
    container: z.string().optional().describe('Container name (for multi-container pods)'),
    tail: z.number().int().positive().default(100).describe('Number of lines'),
    previous: z.boolean().default(false).describe('Show logs from previous container instance'),
});

export function createK8sLogsTool(maxOutputBytes: number) {
    return createTool(
        'k8s.logs',
        `📋 KUBERNETES POD LOGS

Get logs from a Kubernetes pod.

ALLOWED NAMESPACES: ${getAllowedNamespaces().join(', ') || 'all'}

PARAMETERS:
• pod: Pod name (required)
• namespace: Namespace (default: default)
• container: Container name for multi-container pods (optional)
• tail: Number of lines (default: 100)
• previous: Show logs from crashed/previous container (default: false)

EXAMPLES:
1. Get pod logs:
   {"pod": "my-app-xyz123", "namespace": "default", "tail": 100}

2. Specific container:
   {"pod": "my-pod", "container": "sidecar", "tail": 50}

3. Previous crashed container:
   {"pod": "my-pod", "previous": true, "tail": 200}

BEST PRACTICES:
• Use k8s.pods first to get pod names
• Set previous=true for crash investigation
• Increase tail for more context`,
        K8sLogsArgsSchema,
        async (args) => {
            const parsed = K8sLogsArgsSchema.parse(args);

            if (!isNamespaceAllowed(parsed.namespace)) {
                throw new PolicyDeniedError(`Namespace not allowed: ${parsed.namespace}`, 'k8s');
            }

            const kubectlArgs = ['logs', parsed.pod, '-n', parsed.namespace, '--tail', String(parsed.tail)];

            if (parsed.container) {
                kubectlArgs.push('-c', parsed.container);
            }

            if (parsed.previous) {
                kubectlArgs.push('--previous');
            }

            try {
                const output = await runKubectl(kubectlArgs, 60000);
                const truncated = truncateOutput(output, maxOutputBytes);

                return {
                    content: [{ type: 'text', text: truncated }],
                };
            } catch (e: unknown) {
                logger.warn({ pod: parsed.pod, error: String(e) }, 'k8s.logs failed');
                throw new ToolExecutionError('k8s.logs', e);
            }
        }
    );
}

// K8s Describe Tool
const K8sDescribeArgsSchema = z.object({
    resource: z.enum(['pod', 'deployment', 'service', 'ingress', 'configmap', 'secret', 'node', 'pvc']),
    name: z.string().describe('Resource name'),
    namespace: z.string().default('default'),
});

export function createK8sDescribeTool(maxOutputBytes: number) {
    return createTool(
        'k8s.describe',
        `🔍 KUBERNETES DESCRIBE

Get detailed information about a Kubernetes resource.

PARAMETERS:
• resource: Resource type (pod, deployment, service, ingress, configmap, secret, node, pvc)
• name: Resource name
• namespace: Namespace (default: default)

EXAMPLES:
1. Describe pod:
   {"resource": "pod", "name": "my-app-xyz123", "namespace": "default"}

2. Describe deployment:
   {"resource": "deployment", "name": "my-app", "namespace": "production"}

3. Describe service:
   {"resource": "service", "name": "my-service"}

USE CASES:
• Debug pod scheduling issues (Events section)
• Check resource limits and requests
• Verify configuration
• Investigate crashes`,
        K8sDescribeArgsSchema,
        async (args) => {
            const parsed = K8sDescribeArgsSchema.parse(args);

            if (!isNamespaceAllowed(parsed.namespace) && parsed.resource !== 'node') {
                throw new PolicyDeniedError(`Namespace not allowed: ${parsed.namespace}`, 'k8s');
            }

            const kubectlArgs = ['describe', parsed.resource, parsed.name];

            if (parsed.resource !== 'node') {
                kubectlArgs.push('-n', parsed.namespace);
            }

            try {
                const output = await runKubectl(kubectlArgs);
                const truncated = truncateOutput(output, maxOutputBytes);

                return {
                    content: [{ type: 'text', text: truncated }],
                };
            } catch (e: unknown) {
                logger.warn({ resource: parsed.resource, name: parsed.name, error: String(e) }, 'k8s.describe failed');
                throw new ToolExecutionError('k8s.describe', e);
            }
        }
    );
}

// K8s Events Tool
const K8sEventsArgsSchema = z.object({
    namespace: z.string().default('default'),
    allNamespaces: z.boolean().default(false),
});

export function createK8sEventsTool(maxOutputBytes: number) {
    return createTool(
        'k8s.events',
        `📢 KUBERNETES EVENTS

List cluster events - useful for debugging.

PARAMETERS:
• namespace: Namespace (default: default)
• allNamespaces: List from all namespaces (default: false)

EXAMPLES:
1. Events in default namespace:
   {"namespace": "default"}

2. All cluster events:
   {"allNamespaces": true}

USE CASES:
• Debug pod scheduling failures
• Find image pull errors
• Investigate crash loops
• Monitor cluster issues`,
        K8sEventsArgsSchema,
        async (args) => {
            const parsed = K8sEventsArgsSchema.parse(args);

            if (!parsed.allNamespaces && !isNamespaceAllowed(parsed.namespace)) {
                throw new PolicyDeniedError(`Namespace not allowed: ${parsed.namespace}`, 'k8s');
            }

            const kubectlArgs = ['get', 'events', '--sort-by=.metadata.creationTimestamp'];

            if (parsed.allNamespaces) {
                kubectlArgs.push('--all-namespaces');
            } else {
                kubectlArgs.push('-n', parsed.namespace);
            }

            try {
                const output = await runKubectl(kubectlArgs);
                const truncated = truncateOutput(output, maxOutputBytes);

                return {
                    content: [{ type: 'text', text: truncated }],
                };
            } catch (e: unknown) {
                logger.warn({ error: String(e) }, 'k8s.events failed');
                throw new ToolExecutionError('k8s.events', e);
            }
        }
    );
}
