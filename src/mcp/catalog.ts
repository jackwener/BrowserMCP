/** Static MCP surface for a launcher that starts before the Chrome-owned host. */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from './server.js';

export async function localCatalog(version: string) {
  // Reuse the real registrations so offline discovery cannot drift from the host's schemas.
  // This runtime only describes tools; it never handles an agent request or owns browser state.
  const rt = new Runtime();
  const session = createMcpServer(rt, 'catalog', { version });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'opencli-mcp-catalog', version }, { capabilities: {} });
  try {
    await session.server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      tools: await client.listTools(),
      resources: await client.listResources(),
      resourceTemplates: await client.listResourceTemplates(),
      prompts: await client.listPrompts(),
    };
  } finally {
    await client.close().catch(() => {});
    await session.server.close().catch(() => {});
    await session.close();
  }
}
