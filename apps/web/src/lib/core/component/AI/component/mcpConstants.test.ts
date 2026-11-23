import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('gives AI clients the instance’s own endpoint behind a self-hosted backend', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
  vi.resetModules();
  const { CLI_COMMANDS, MACRO_MCP_CONFIG, MACRO_MCP_URL } = await import(
    './mcpConstants'
  );

  expect(MACRO_MCP_URL).toBe('https://api.example.com/mcp');
  expect(JSON.parse(MACRO_MCP_CONFIG).mcpServers.macro.url).toBe(
    'https://api.example.com/mcp'
  );
  expect(CLI_COMMANDS.map(({ command }) => command)).toEqual([
    'claude mcp add --transport http macro https://api.example.com/mcp',
    'codex mcp add macro --url https://api.example.com/mcp',
  ]);
});

it('keeps the hosted endpoint in every other build', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
  vi.resetModules();
  const { MACRO_MCP_URL } = await import('./mcpConstants');

  expect(MACRO_MCP_URL).toBe('https://mcp-server.macro.com/mcp');
});
