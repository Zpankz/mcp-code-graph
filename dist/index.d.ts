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
import { z } from "zod";
/**
 * Configuration schema for Smithery deployment
 * Users will see this as a form in the Smithery UI
 */
export declare const configSchema: z.ZodObject<{
    apiKey: z.ZodString;
    orgId: z.ZodOptional<z.ZodString>;
    graphId: z.ZodOptional<z.ZodString>;
    repoUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    apiKey: string;
    orgId?: string | undefined;
    graphId?: string | undefined;
    repoUrl?: string | undefined;
}, {
    apiKey: string;
    orgId?: string | undefined;
    graphId?: string | undefined;
    repoUrl?: string | undefined;
}>;
export type ServerConfig = z.infer<typeof configSchema>;
/**
 * Create and configure MCP server instance
 * This is the main factory function used by both Smithery and direct execution
 */
export default function createServer({ config: userConfig }?: {
    config?: ServerConfig;
}): import("@modelcontextprotocol/sdk/server/index.js").Server<{
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
        } | undefined;
    } | undefined;
}, {
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | undefined;
}, {
    [x: string]: unknown;
    _meta?: {
        [x: string]: unknown;
    } | undefined;
}>;
