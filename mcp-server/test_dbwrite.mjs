import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PERSONA_ID = '86b5bf90-4ad6-4a71-90a0-43c567c6ad09';

const transport = new SSEClientTransport(new URL('http://localhost:3100/sse'));
const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

await client.connect(transport);
console.log('[test] Connected');

console.log('[test] Calling db_write...');
const writeResult = await client.callTool({
  name: 'db_write',
  arguments: {
    persona_id: PERSONA_ID,
    table: 'entities',
    record: JSON.stringify({
      entity_type: 'organization',
      canonical_name: 'Sprint 2 Test Entity',
      first_seen_source: 'sprint2-db_write-validation',
      confidence_score: 1.0,
      created_by_persona_id: PERSONA_ID,
    }),
  },
});
console.log('[test] db_write result:', JSON.stringify(writeResult, null, 2));

await client.close();
console.log('[test] Done');
