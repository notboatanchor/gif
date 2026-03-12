import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const REVOKED_PERSONA_ID = '3006a265-c983-4364-ba5d-e68869988c75';

const transport = new SSEClientTransport(new URL('http://localhost:3100/sse'));
const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

await client.connect(transport);
console.log('[test] Connected');

console.log('[test] Calling web_search with revoked persona...');
const result = await client.callTool({
  name: 'web_search',
  arguments: {
    persona_id: REVOKED_PERSONA_ID,
    query: 'this should be rejected',
    max_results: 1,
  },
});
console.log('[test] Result:', JSON.stringify(result, null, 2));

await client.close();
console.log('[test] Done');
