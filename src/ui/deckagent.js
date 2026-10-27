// The AI deck helper's conversation with Claude. The page talks to the Claude API through this site's own server
// (worker/ai.js holds the key, sets the model, instructions and tools, and limits how much it can be used), and runs
// the tools itself (agenttools.js) on the card index and the deck being built: the model asks to search cards or add
// some, the page does it and sends back what happened, until the model has its answer. Text streams in as it's written.
// Built as its own file (dist/ai.js, with the Anthropic SDK) that aiload.js fetches only when the helper is opened.
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, SYSTEM, TOOLS } from '../ai/agentspec.js';

const MAX_STEPS = 12;                 // tool round trips in one answer
const MAX_HISTORY_CHARS = 160_000;    // a longer chat starts over (the deck status keeps the model up to date)

// a client for this site's server (the "key" is a placeholder: the server adds the real one, so it never reaches the page)
export function makeClient(origin) {
  return new Anthropic({ apiKey: 'set-by-lotus-goats-server', baseURL: `${origin}/ai`, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 120_000 });
}

// what goes back to the model from an answer: after a safety fallback mid-answer, the declined part's reasoning and
// tool calls are left out (its text stays)
function echoable(content) {
  const last = content.map(b => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  return content.filter((b, i) => i > last || !['thinking', 'redacted_thinking', 'tool_use', 'fallback'].includes(b.type));
}

export class AgentError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// One answer: the player's message (with the deck's status in front), then model turns and tool calls until it's done.
// history: the conversation so far (kept exactly as the API returned it); returns the new history.
// on: { text(delta), tool(name, input, result), step() }
export async function runTurn({ client, history, status, message, runTool, on, signal }) {
  let messages = history;
  let fresh = false;
  if (JSON.stringify(messages).length > MAX_HISTORY_CHARS) { messages = []; fresh = true; }
  messages = [...messages, { role: 'user', content: [{ type: 'text', text: `[${status}]\n\n${message}` }] }];
  for (let step = 0; step < MAX_STEPS; step++) {
    let final;
    try {
      const stream = client.beta.messages.stream({ model: DEFAULT_MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages }, { signal });
      stream.on('text', d => on.text(d));
      final = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) throw new AgentError('stopped', 'Stopped.');
      if (e instanceof Anthropic.RateLimitError) throw new AgentError('limited', (e.error && e.error.error && e.error.error.message) || 'The AI helper is busy. Try again in a little while.');
      if (e instanceof Anthropic.APIError && e.status === 503) throw new AgentError('off', 'The AI helper is switched off right now.');
      if (e instanceof Anthropic.APIConnectionError) throw new AgentError('offline', 'Couldn’t reach the AI helper. Check your connection.');
      if (e instanceof Anthropic.APIError) throw new AgentError('error', 'The AI helper had a problem. Try again in a moment.');
      throw e;
    }
    if (final.stop_reason === 'refusal') {
      // (the declined answer isn't kept; the chat carries on from the player's message)
      throw new AgentError('refusal', 'I can’t help with that one. Let’s get back to your deck!');
    }
    const content = echoable(final.content);
    messages = [...messages, { role: 'assistant', content }];
    if (final.stop_reason === 'pause_turn') continue;
    const uses = content.filter(b => b.type === 'tool_use');
    if (!uses.length) return { history: messages, fresh };
    if (final.stop_reason === 'max_tokens') throw new AgentError('error', 'That answer ran too long. Try asking for a bit less at once.');
    // every tool call answered in one message, in order
    const results = [];
    for (const u of uses) {
      const result = runTool(u.name, u.input);
      on.tool(u.name, u.input || {}, result);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result), ...(result && result.error ? { is_error: true } : {}) });
    }
    messages = [...messages, { role: 'user', content: results }];
    on.step();
  }
  return { history: messages, fresh, cut: true };
}
