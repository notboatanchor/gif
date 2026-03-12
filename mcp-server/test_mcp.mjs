import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const transport = new SSEClientTransport(new URL('http://localhost:3100/sse'));
const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

await client.connect(transport);
console.log('[test] Connected');

// Test 1: web_search
console.log('[test] Calling web_search...');
const searchResult = await client.callTool({
  name: 'web_search',
  arguments: {
    persona_id: '3006a265-c983-4364-ba5d-e68869988c75',
    query: 'federal contracting news',
    max_results: 3,
  },
});
console.log('[test] web_search result:', JSON.stringify(searchResult, null, 2));

// Test 2: db_read
console.log('[test] Calling db_read...');
const dbResult = await client.callTool({
  name: 'db_read',
  arguments: {
    persona_id: '3006a265-c983-4364-ba5d-e68869988c75',
    table: 'personas',
    limit: 3,
  },
});
console.log('[test] db_read result:', JSON.stringify(dbResult, null, 2));

await client.close();
console.log('[test] Done');
