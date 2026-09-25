// Stands in for another tool's passive hook (what emdash's is meant to be): records that it
// ran, prints nothing, exits 0.
import { appendFileSync } from 'node:fs';
let b = '';
process.stdin.on('data', (d) => (b += d)).on('end', () => {
  const ev = JSON.parse(b || '{}');
  appendFileSync('C:/D/orchestrator/spikes/03-hook-coexistence/out/other-tool.log', `${new Date().toISOString()} ${ev.hook_event_name} ${ev.tool_name ?? ''}\n`);
});
