import { readFile, writeFile } from 'node:fs/promises';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('Usage: npm run plugin:url -- https://your-domain.example/mcp');

const url = new URL(endpoint);
if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
  throw new Error('The MCP URL must use HTTPS outside local development.');
}
if (url.pathname !== '/mcp') throw new Error('The MCP URL must end with /mcp.');

const path = new URL('../plugins/custom-email/.mcp.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.mcpServers['custom-email'].url = url.toString();
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Custom Email plugin now points to ${url}`);
