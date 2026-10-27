// A stand-in for the Claude Messages API, for testing the AI deck helper without a key or any cost: it answers
// POST /v1/messages with a scripted, streamed reply in the API's own event format (a reasoning block, text, tool
// calls), keeps every request it gets (GET /requests), and checks the key it's sent. Point the Worker at it with
// AI_API_BASE (see tools/aitest.mjs). The script, by the player's last words:
//   "dragon..."   find_commanders, then set_commander on the first one found, then auto_build, then a reply
//   "add..."      add_cards Sol Ring and Lightning Bolt, then a reply
//   "deck..."     get_deck, then a reply
//   "refuse..."   a safety refusal
//   anything else a short reply with a card link
import http from 'node:http';

export function startMock({ port = 8798, key = 'test-key' } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/requests') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(requests)); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end(); }
      const body = JSON.parse(raw || '{}');
      requests.push({ headers: req.headers, body });
      // (the SDK sends the key as a Bearer token; older clients use x-api-key)
      if (req.headers['x-api-key'] !== key && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      const reply = script(body.messages || []);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      const id = `msg_mock_${++n}`;
      send('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
      let i = 0;
      if (reply.stop === 'refusal') {
        send('message_delta', { delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 0 } });
        send('message_stop', {});
        return res.end();
      }
      // a reasoning block, as the real model sends (empty text, a signature)
      send('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: `sig-${id}` } });
      send('content_block_stop', { index: i++ });
      if (reply.text) {
        send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        for (const chunk of reply.text.match(/.{1,12}/gs)) { send('content_block_delta', { index: i, delta: { type: 'text_delta', text: chunk } }); await new Promise(r => setTimeout(r, 15)); }
        send('content_block_stop', { index: i++ });
      }
      if (reply.tool) {
        const input = JSON.stringify(reply.tool.input);
        send('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: reply.tool.name, input: {} } });
        for (const chunk of input.match(/.{1,10}/gs)) send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: chunk } });
        send('content_block_stop', { index: i++ });
      }
      send('message_delta', { delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ requests, close: () => server.close() })));
}

function script(messages) {
  const last = messages[messages.length - 1] || { content: [] };
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
  const results = blocks.filter(b => b.type === 'tool_result');
  if (results.length) {
    const prev = messages[messages.length - 2];
    const use = (prev.content || []).find(b => b.type === 'tool_use');
    let r = {};
    try { r = JSON.parse(results[0].content); } catch { /* not JSON */ }
    switch (use && use.name) {
      case 'find_commanders': return { text: 'Here’s a great one for dragons.', tool: { name: 'set_commander', input: { name: r.commanders[0].name } } };
      case 'set_commander': return { tool: { name: 'auto_build', input: { mode: 'fill', focus: 'dragons' } } };
      case 'auto_build': return { text: `Your deck is ready: ${r.total} cards! I built it around [[${(r.added_spells || [])[0] || 'Sol Ring'}]] and friends.\n\n- More dragons\n- Plenty of **ramp**` };
      case 'add_cards': return { text: `Added ${(r.added || []).map(x => `[[${x}]]`).join(' and ')}.` };
      case 'get_deck': return { text: `Your deck has ${r.total} cards.` };
      default: return { text: 'Done.' };
    }
  }
  const said = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/^\[[^\]]*\]\s*/, '').toLowerCase();
  if (said.includes('refuse')) return { stop: 'refusal' };
  if (said.includes('dragon')) return { text: 'Let me find you a dragon commander.', tool: { name: 'find_commanders', input: { query: 'dragons', limit: 3 } } };
  if (said.includes('add')) return { tool: { name: 'add_cards', input: { cards: [{ name: 'Sol Ring' }, { name: 'Lightning Bolt' }] } } };
  if (said.includes('deck')) return { tool: { name: 'get_deck', input: {} } };
  return { text: `Hi! You said “${said.slice(0, 60)}”. Every deck loves a [[Sol Ring]].` };
}

if (process.argv[1] && process.argv[1].endsWith('mockclaude.mjs')) {
  const port = +(process.argv[2] || 8798);
  await startMock({ port });
  console.log(`mock Claude API on http://127.0.0.1:${port}`);
}
