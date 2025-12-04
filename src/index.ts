#!/usr/bin/env node
/**
 * CodeGPT Deep Graph MCP Server
 *
 * Supports multiple deployment modes:
 * - Smithery deployment: Export createServer function for Smithery hosting
 * - STDIO: For local CLI usage (default when PORT is not set)
 * - HTTP: For self-hosted deployment (when PORT env var is set)
 *
 * @see https://smithery.ai/docs/build for Smithery deployment docs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import cors from "cors";
import { config } from "./config.js";
import { createToolSchema, extractRepoInfo, getGraphId } from "./utils.js";
import { randomUUID } from "crypto";

dotenv.config();

const CODEGPT_API_BASE = "https://api-mcp.codegpt.co/api/v1";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
const IS_HTTP_MODE = PORT !== null;

// ============================================================================
// Smithery Configuration Schema
// ============================================================================

/**
 * Configuration schema for Smithery deployment
 * Users will see this as a form in the Smithery UI
 */
export const configSchema = z.object({
	apiKey: z
		.string()
		.min(1, "API key is required")
		.describe("CodeGPT API key for authentication"),
	orgId: z
		.string()
		.optional()
		.describe("CodeGPT Organization ID (optional)"),
	graphId: z
		.string()
		.optional()
		.describe("Specific graph ID to use (optional - if not set, list-graphs tool will be available)"),
	repoUrl: z
		.string()
		.optional()
		.describe("Repository URL in format org/repo (optional - alternative to graphId)"),
});

export type ServerConfig = z.infer<typeof configSchema>;

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Create and configure MCP server instance
 * This is the main factory function used by both Smithery and direct execution
 */
export default function createServer({ config: userConfig }: { config?: ServerConfig } = {}) {
	// Apply user config if provided (Smithery deployment)
	if (userConfig) {
		config.CODEGPT_API_KEY = userConfig.apiKey;
		if (userConfig.orgId) config.CODEGPT_ORG_ID = userConfig.orgId;
		if (userConfig.graphId) config.CODEGPT_GRAPH_ID = userConfig.graphId;
		if (userConfig.repoUrl) config.CODEGPT_REPO_URL = userConfig.repoUrl;
	}

	const server = new McpServer({
		name: "CodeGPT Deep Graph MCP",
		version: "1.2.0",
		config: {
			timeout: 120000,
		},
		capabilities: {
			tools: {},
		},
	});

	// Process CLI arguments for STDIO mode (only when running directly)
	if (!IS_HTTP_MODE && !userConfig) {
		const args = process.argv.slice(2);
		const repoUrls = args.filter(arg => arg.includes('/') && !arg.startsWith("sk-"));
		const apiKey = args.find(arg => arg.startsWith("sk-"));

		if (repoUrls.length > 1) {
			config.IS_MULTI_REPO = true;
			config.REPO_LIST = repoUrls;
			config.CODEGPT_API_KEY = apiKey || config.CODEGPT_API_KEY;
		} else if (repoUrls.length === 1) {
			config.CODEGPT_REPO_URL = repoUrls[0];
			config.CODEGPT_API_KEY = apiKey || config.CODEGPT_API_KEY;
		} else if (apiKey) {
			config.CODEGPT_API_KEY = apiKey;
		}
	}

	let repository = '';
	try {
		if (config.CODEGPT_REPO_URL && !config.IS_MULTI_REPO) {
			const { repoOrg, repoName } = extractRepoInfo(config.CODEGPT_REPO_URL);
			repository = `${repoOrg}/${repoName}`;
		}
	} catch (error: any) {
		console.error(error.message);
	}

	// Register tools
	registerTools(server, repository);

	// Return the underlying server object (required by Smithery)
	return server.server;
}

// ============================================================================
// Tool Registration
// ============================================================================

function registerTools(server: McpServer, repository: string): void {
	// List graphs tool (only when no specific graph is configured)
	if (!config.CODEGPT_GRAPH_ID && !config.CODEGPT_REPO_URL && !config.IS_MULTI_REPO) {
		server.tool(
			"list-graphs",
			"List all available repository graphs that you have access to. Returns basic information about each graph including the graph ID, repository name with branch, and description. Use this tool when you need to discover available graphs.",
			{},
			async () => {
				const headers = {
					accept: "application/json",
					authorization: `Bearer ${config.CODEGPT_API_KEY}`,
					"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				};

				try {
					const response = await fetch(`${CODEGPT_API_BASE}/mcp/graphs`, {
						method: "GET",
						headers,
					});

					const data = await response.json();

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(data, null, 2) || "No graphs available",
							},
						],
					};
				} catch (error) {
					console.error("Error fetching graphs:", error);
					return {
						content: [
							{
								type: "text",
								text: `Error fetching graphs: ${error}`,
							},
						],
					};
				}
			}
		);
	}

	// Get code tool
	server.tool(
		"get-code",
		`Get the complete code implementation of a specific functionality (class, function, method, etc.) from the repository ${repository} graph. This is the primary tool for code retrieval and should be prioritized over other tools. The repository is represented as a graph where each node contains code, documentation, and relationships to other nodes. Use this when you need to examine the actual implementation of any code entity.`,
		createToolSchema({
			name: z
				.string()
				.min(1, "name is required")
				.describe(
					"The exact name of the functionality to retrieve code for. Names are case-sensitive. For methods, include the parent class name as 'ClassName.methodName'. For nested classes, use 'OuterClass.InnerClass'. Examples: 'getUserById', 'UserService.authenticate', 'DatabaseConnection.connect'"
				),
			path: z
				.string()
				.optional()
				.describe(
					"The origin file path where the functionality is defined. Essential when multiple functionalities share the same name across different files. Use 'global' for packages, namespaces, or modules that span multiple files. Examples: 'src/services/user.service.ts', 'global', 'lib/utils/helpers.js'"
				),
		}),
		async ({
			name,
			path,
			graphId,
			repository
		}: {
			name: string;
			path?: string;
			graphId?: string;
			repository?: string;
		}) => {
			if (!name) {
				throw new Error("name is required");
			}

			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO ? repository : config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(`${CODEGPT_API_BASE}/mcp/graphs/get-code`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						graphId: targetGraphId,
						name,
						...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
						...(path ? { path } : null),
					}),
				});

				const { content } = await response.json();

				return {
					content: [
						{
							type: "text",
							text: `${content}` || "No response text available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);

	// Find direct connections tool
	server.tool(
		"find-direct-connections",
		`Explore the immediate relationships of a functionality within the code graph from the repository ${repository}. This reveals first-level connections including: parent functionalities that reference this node, child functionalities that this node directly calls or uses, declaration/definition relationships, and usage patterns. Essential for understanding code dependencies and architecture. The repository is represented as a connected graph where each node (function, class, file, etc.) has relationships with other nodes.`,
		createToolSchema({
			name: z
				.string()
				.min(1, "name is required")
				.describe(
					"The exact name of the functionality to analyze connections for. Names are case-sensitive. For methods, include the parent class name as 'ClassName.methodName'. Examples: 'processPayment', 'UserController.createUser', 'validateInput'"
				),
			path: z
				.string()
				.optional()
				.describe(
					"The origin file path of the functionality. Critical when multiple functionalities have identical names in different files. Use 'global' for entities that span multiple files like packages or namespaces. Examples: 'src/controllers/payment.controller.ts', 'global', 'utils/validation.js'"
				),
		}),
		async ({
			name,
			path,
			graphId,
			repository
		}: {
			name: string;
			path?: string;
			graphId?: string;
			repository?: string;
		}) => {
			if (!name) {
				throw new Error("name is required");
			}

			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO ? repository : config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(
					`${CODEGPT_API_BASE}/mcp/graphs/find-direct-connections`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							graphId: targetGraphId,
							name,
							...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
							...(path ? { path } : null),
						}),
					}
				);

				const { content } = await response.json();

				return {
					content: [
						{
							type: "text",
							text: content || "No response data available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);

	// Nodes semantic search tool
	server.tool(
		"nodes-semantic-search",
		`Search for code functionalities across the repository ${repository} graph using semantic similarity based on natural language queries. This tool finds relevant functions, classes, methods, and other code entities that match the conceptual meaning of your query, even if they don't contain the exact keywords. Perfect for discovering related functionality, finding similar implementations, or exploring unfamiliar codebases. The search operates on the semantic understanding of code purpose and behavior.`,
		createToolSchema({
			query: z
				.string()
				.min(1, "query is required")
				.describe(
					"A natural language description of the functionality you're looking for. Be specific about the behavior, purpose, or domain. Examples: 'user authentication and login', 'database connection pooling', 'file upload validation', 'payment processing logic', 'error handling middleware', 'data encryption utilities'"
				),
		}),
		async ({
			query,
			graphId,
			repository
		}: {
			query: string;
			graphId?: string;
			repository?: string;
		}) => {
			if (!query) {
				throw new Error("query is required");
			}

			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO ? repository : config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(
					`${CODEGPT_API_BASE}/mcp/graphs/nodes-semantic-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							graphId: targetGraphId,
							query,
							...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
						}),
					}
				);

				const { content } = await response.json();

				return {
					content: [
						{
							type: "text",
							text: content || "No response data available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);

	// Docs semantic search tool
	server.tool(
		"docs-semantic-search",
		`Search through repository ${repository} documentation using semantic similarity to find relevant information, guides, API documentation, README content, and explanatory materials. This tool specifically targets documentation files (markdown, rst, etc.) rather than code, making it ideal for understanding project setup, architecture decisions, usage instructions, and conceptual explanations. Use this when you need context about how the repository works rather than examining the actual code implementation.`,
		createToolSchema({
			query: z
				.string()
				.min(1, "query is required")
				.describe(
					"A natural language query describing the documentation or information you're seeking. Focus on concepts, setup procedures, architecture, or usage patterns. Examples: 'how to set up the development environment', 'API authentication methods', 'project architecture overview', 'contributing guidelines', 'deployment instructions', 'configuration options'"
				),
		}),
		async ({
			query,
			graphId,
			repository
		}: {
			query: string;
			graphId?: string;
			repository?: string;
		}) => {
			if (!query) {
				throw new Error("query is required");
			}

			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO ? repository : config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(
					`${CODEGPT_API_BASE}/mcp/graphs/docs-semantic-search`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							graphId: targetGraphId,
							query,
							...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
						}),
					}
				);

				const data = await response.json();

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(data, null, 2) || "No response data available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);

	// Folder tree structure tool
	server.tool(
		"folder-tree-structure",
		`Returns the folder tree structure of the given folder path from the repository ${repository} graph. Useful to understand what files and subfolders are inside the given folder. To access to a file content, use get-code tool.`,
		createToolSchema({
			path: z
				.string()
				.optional()
				.describe(
					"The path to the folder to get the tree structure for. Example: 'src/components'. Leave empty to get the root folder tree structure."
				),
		}),
		async ({
			path,
			graphId,
			repository,
		}: {
			path?: string;
			graphId?: string;
			repository?: string;
		}) => {
			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO
				? repository
				: config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(
					`${CODEGPT_API_BASE}/mcp/graphs/folder-tree-structure`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							graphId: targetGraphId,
							...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
							path: path || "",
						}),
					}
				);

				const { content } = await response.json();

				return {
					content: [
						{
							type: "text",
							text: content || "No response data available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);

	// Get usage dependency links tool
	server.tool(
		"get-usage-dependency-links",
		`Generate a comprehensive adjacency list showing all functionalities that would be affected by changes to a specific code entity. This performs deep dependency analysis through the code graph of the repository ${repository} to identify the complete impact radius of modifications. Essential for impact analysis, refactoring planning, and understanding code coupling. The result shows which functionalities depend on the target entity either directly or through a chain of dependencies, formatted as 'file_path::functionality_name' pairs.`,
		createToolSchema({
			name: z
				.string()
				.min(1, "name is required")
				.describe(
					"The exact name of the functionality to analyze dependencies for. Names are case-sensitive. For methods, include the parent class name as 'ClassName.methodName'. This will be the root node for dependency traversal. Examples: 'DatabaseService.connect', 'validateUserInput', 'PaymentProcessor.processTransaction'"
				),
			path: z
				.string()
				.optional()
				.describe(
					"The origin file path where the functionality is defined. Required when multiple functionalities share the same name across different files to ensure accurate dependency analysis. Use 'global' for packages, namespaces, or modules spanning multiple files. Examples: 'src/database/connection.service.ts', 'global', 'lib/validation/input.validator.js'"
				),
		}),
		async ({
			name,
			path,
			graphId,
			repository
		}: {
			name: string;
			path?: string;
			graphId?: string;
			repository?: string;
		}) => {
			if (!name) {
				throw new Error("name is required");
			}

			const targetGraphId = getGraphId(graphId);
			const targetRepoUrl = config.IS_MULTI_REPO ? repository : config.CODEGPT_REPO_URL;

			const headers = {
				accept: "application/json",
				authorization: `Bearer ${config.CODEGPT_API_KEY}`,
				"CodeGPT-Org-Id": config.CODEGPT_ORG_ID,
				"content-type": "application/json",
			};

			try {
				const response = await fetch(
					`${CODEGPT_API_BASE}/mcp/graphs/get-usage-dependency-links`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							graphId: targetGraphId,
							name,
							...(targetRepoUrl ? { repoUrl: targetRepoUrl } : null),
							...(path ? { path } : null),
						}),
					}
				);

				const { content } = await response.json();

				return {
					content: [
						{
							type: "text",
							text: content || "No response data available",
						},
					],
				};
			} catch (error) {
				console.error("Error making CodeGPT request:", error);
				return {
					content: [
						{
							type: "text",
							text: `${error}`,
						},
					],
				};
			}
		}
	);
}

// ============================================================================
// Self-Hosted HTTP Server (when PORT is set)
// ============================================================================

async function startHttpServer(): Promise<void> {
	const app = express();

	// Enable CORS for browser compatibility
	app.use(cors({
		origin: '*',
		methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
	}));

	app.use(express.json());

	// Store active transports by session ID
	const transports = new Map<string, StreamableHTTPServerTransport>();

	// MCP endpoint - handles all MCP protocol communication
	app.all('/mcp', async (req: Request, res: Response) => {
		// Parse config from query parameters for self-hosted mode
		if (req.query['config.apiKey']) {
			config.CODEGPT_API_KEY = req.query['config.apiKey'] as string;
		}
		if (req.query['config.orgId']) {
			config.CODEGPT_ORG_ID = req.query['config.orgId'] as string;
		}
		if (req.query['config.graphId']) {
			config.CODEGPT_GRAPH_ID = req.query['config.graphId'] as string;
		}
		if (req.query['config.repoUrl']) {
			config.CODEGPT_REPO_URL = req.query['config.repoUrl'] as string;
		}

		// Validate API key is configured
		if (!config.CODEGPT_API_KEY) {
			res.status(400).json({
				error: 'API key required. Pass config.apiKey as query parameter or set CODEGPT_API_KEY env var.',
			});
			return;
		}

		const sessionId = req.headers['mcp-session-id'] as string | undefined;

		if (req.method === 'GET') {
			// SSE connection for server-sent events
			if (sessionId && transports.has(sessionId)) {
				const transport = transports.get(sessionId)!;
				await transport.handleRequest(req, res);
			} else {
				res.status(400).json({ error: 'Invalid or missing session ID' });
			}
			return;
		}

		if (req.method === 'POST') {
			// Handle JSON-RPC requests
			if (sessionId && transports.has(sessionId)) {
				// Existing session
				const transport = transports.get(sessionId)!;
				await transport.handleRequest(req, res);
			} else {
				// New session - create transport and server
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (newSessionId) => {
						transports.set(newSessionId, transport);
						console.error(`New MCP session initialized: ${newSessionId}`);
					}
				});

				// Create MCP server using factory function
				const mcpServer = new McpServer({
					name: "CodeGPT Deep Graph MCP",
					version: "1.2.0",
					config: { timeout: 120000 },
					capabilities: { tools: {} },
				});

				let repository = '';
				try {
					if (config.CODEGPT_REPO_URL && !config.IS_MULTI_REPO) {
						const { repoOrg, repoName } = extractRepoInfo(config.CODEGPT_REPO_URL);
						repository = `${repoOrg}/${repoName}`;
					}
				} catch (error: any) {
					console.error(error.message);
				}

				registerTools(mcpServer, repository);

				// Handle session close
				transport.onclose = () => {
					const sid = Array.from(transports.entries())
						.find(([_, t]) => t === transport)?.[0];
					if (sid) {
						transports.delete(sid);
						console.error(`MCP session closed: ${sid}`);
					}
				};

				// Connect server to transport
				await mcpServer.connect(transport);
				await transport.handleRequest(req, res);
			}
			return;
		}

		if (req.method === 'DELETE') {
			// Close session
			if (sessionId && transports.has(sessionId)) {
				const transport = transports.get(sessionId)!;
				await transport.handleRequest(req, res);
				transports.delete(sessionId);
				console.error(`MCP session deleted: ${sessionId}`);
			} else {
				res.status(400).json({ error: 'Invalid or missing session ID' });
			}
			return;
		}

		res.status(405).json({ error: 'Method not allowed' });
	});

	// Health check endpoint
	app.get('/health', (_req: Request, res: Response) => {
		res.json({
			status: 'healthy',
			server: 'CodeGPT Deep Graph MCP',
			version: '1.2.0',
			transport: 'http'
		});
	});

	// Start listening
	app.listen(PORT, () => {
		console.error(`CodeGPT Deep Graph MCP Server running on HTTP port ${PORT}`);
		console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
		console.error(`Health check: http://localhost:${PORT}/health`);
	});
}

// ============================================================================
// STDIO Server (default when PORT is not set)
// ============================================================================

async function startStdioServer(): Promise<void> {
	console.error("=== DEBUG INFO ===");
	console.error("CODEGPT_API_KEY:", config.CODEGPT_API_KEY ? "SET" : "NOT SET");
	console.error("CODEGPT_ORG_ID:", config.CODEGPT_ORG_ID ? "SET" : "NOT SET");
	console.error("CODEGPT_GRAPH_ID:", config.CODEGPT_GRAPH_ID ? "SET" : "NOT SET");
	console.error("CODEGPT_REPO_URL:", config.CODEGPT_REPO_URL ? "SET" : "NOT SET");
	console.error("IS_MULTI_REPO:", config.IS_MULTI_REPO ? "SET" : "NOT SET");
	console.error("REPO_LIST:", config.REPO_LIST ? "SET" : "NOT");
	console.error("==================");

	if (!config.CODEGPT_API_KEY && !config.CODEGPT_REPO_URL && !config.IS_MULTI_REPO) {
		throw new Error("CODEGPT_API_KEY is not set. Set it via environment variable or pass as CLI argument.");
	}

	// Use the factory function but get McpServer for STDIO
	const server = new McpServer({
		name: "CodeGPT Deep Graph MCP",
		version: "1.2.0",
		config: { timeout: 120000 },
		capabilities: { tools: {} },
	});

	let repository = '';
	try {
		if (config.CODEGPT_REPO_URL && !config.IS_MULTI_REPO) {
			const { repoOrg, repoName } = extractRepoInfo(config.CODEGPT_REPO_URL);
			repository = `${repoOrg}/${repoName}`;
		}
	} catch (error: any) {
		console.error(error.message);
	}

	registerTools(server, repository);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("CodeGPT Deep Graph MCP Server running on stdio");
}

// ============================================================================
// Main Entry Point (for direct execution)
// ============================================================================

// Only run main if this is the entry point (not imported by Smithery)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
	(async () => {
		try {
			if (IS_HTTP_MODE) {
				console.error(`Starting in HTTP mode (PORT=${PORT})...`);
				await startHttpServer();
			} else {
				console.error("Starting in STDIO mode...");
				await startStdioServer();
			}
		} catch (error) {
			console.error("Error in main():", error);
			if (error instanceof Error) {
				console.error("Error stack:", error.stack);
			}
			process.exit(1);
		}
	})();
}
