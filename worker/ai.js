// The AI deck helper's connection to the Claude API. The page's SDK client points at /ai, so its requests arrive at
// /ai/v1/messages; this server keeps only the conversation from them and sends its own model, instructions and tools
// (src/ai/agentspec.js) with the site's API key, then streams Claude's answer straight back. So the key never reaches a
// browser, and nobody can use the site's key for anything but the deck helper.
//
// Settings (Cloudflare dashboard, Worker -> Settings -> Variables and Secrets):
//   ANTHROPIC_API_KEY   secret: switches the AI helper on (without it the page uses its built-in helper)
//   AI_MODEL            optional: another Claude model (default claude-opus-5-5)
//   AI_EFFORT           optional: low | medium | high (default low: quick answers)
//   AI_DAILY_LIMIT      optional: requests a day for the whole site (default 300), a cap on what it can cost
//   AI_HOURLY_PER_IP    optional: requests an hour from one address (default 120; a school shares one address)
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, SYSTEM, TOOLS, TOOL_NAMES } from '../src/ai/agentspec.js';

const MAX_BODY = 200_000;      // characters of request JSON
const MAX_MESSAGES = 80;
const MAX_TEXT = 4000;         // characters a player can type in one message (plus the deck status)
const MAX_RESULT = 30_000;     // characters of one tool result
const json = (cors, v, status = 200, extra = {}) => new Response(JSON.stringify(v), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
// errors in the API's own shape, so the page's SDK reads them like any other API error (and doesn't retry them: the
// server already retried what's worth retrying)
const apiError = (cors, status, type, message) => json(cors, { type: 'error', error: { type, message } }, status, { 'x-should-retry': 'false' });

// only this site's own pages may use it from a browser (another site can't spend its key through visitors' browsers)
const OWN = /^https:\/\/((www\.)?lotusgoats\.com|stigz-s-mtga\.stigzrblx\.workers\.dev|stigzmtg\.github\.io)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function corsFor(req) {
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin && OWN.test(origin) ? origin : 'https://lotusgoats.com',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // (the SDK sends its own headers: allow whatever it asks for; nothing here depends on them)
    'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'x-should-retry, request-id',
  };
}

// only the conversation, rebuilt block by block with the fields each kind of block has (anything else is dropped)
function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_MESSAGES) return null;
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : null;
    if (!blocks || !blocks.length || blocks.length > 80) return null;
    const content = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (m.role === 'user' && b.text.length > MAX_TEXT + 1200) return null;
        content.push({ type: 'text', text: b.text });
      } else if (m.role === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const c = typeof b.content === 'string' ? b.content : '';
        if (c.length > MAX_RESULT) return null;
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: c, ...(b.is_error ? { is_error: true } : {}) });
      } else if (m.role === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && TOOL_NAMES.has(b.name)) {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
      } else if (m.role === 'assistant' && b.type === 'thinking' && typeof b.signature === 'string') {
        content.push({ type: 'thinking', thinking: typeof b.thinking === 'string' ? b.thinking : '', signature: b.signature });
      } else if (m.role === 'assistant' && b.type === 'redacted_thinking' && typeof b.data === 'string') {
        content.push({ type: 'redacted_thinking', data: b.data });
      } else if (b.type === 'fallback') {
        // (a marker of a safety fallback: the API ignores it, so it isn't sent)
      } else return null;
    }
    if (content.length) out.push({ role: m.role, content });
  }
  return out.length && out[0].role === 'user' ? out : null;
}

export async function aiRequest(req, env) {
  const cors = corsFor(req);
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const origin = req.headers.get('Origin');
  if (origin && !OWN.test(origin)) return apiError(cors, 403, 'permission_error', 'The AI helper only works on Lotus Goats.');
  if (url.pathname === '/ai/config') return json(cors, { on: !!env.ANTHROPIC_API_KEY });
  if (url.pathname !== '/ai/v1/messages' || req.method !== 'POST') return apiError(cors, 404, 'not_found_error', 'Not found.');
  if (!env.ANTHROPIC_API_KEY) return apiError(cors, 503, 'overloaded_error', 'The AI helper is switched off.');

  // how much the site's key can be used: per address, and for everyone together each day
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const over = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts')).aiAllow(ip, +env.AI_HOURLY_PER_IP || 120, +env.AI_DAILY_LIMIT || 300);
  if (over === 'ip') return apiError(cors, 429, 'rate_limit_error', 'You’ve used the AI helper a lot this hour. Take a break and try again soon (the simple helper still works).');
  if (over === 'day') return apiError(cors, 429, 'rate_limit_error', 'The AI helper has had a busy day and is resting until tomorrow (the simple helper still works).');

  const text = await req.text();
  if (text.length > MAX_BODY) return apiError(cors, 413, 'request_too_large', 'This chat got too long. Start a new chat.');
  let body;
  try { body = JSON.parse(text); } catch { return apiError(cors, 400, 'invalid_request_error', 'Bad request.'); }
  const messages = cleanMessages(body && body.messages);
  if (!messages) return apiError(cors, 400, 'invalid_request_error', 'Bad conversation.');

  const model = env.AI_MODEL || DEFAULT_MODEL;
  // server-side safety fallback where the model has one (a false-positive decline is retried on another model)
  const fallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.AI_API_BASE ? { baseURL: env.AI_API_BASE } : {}), maxRetries: 2 });
  try {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      // (thinking stays on; a reasoning block the API can't match to this conversation is dropped rather than refused)
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: ['low', 'medium', 'high'].includes(env.AI_EFFORT) ? env.AI_EFFORT : 'low' },
      cache_control: { type: 'ephemeral' },
      ...(fallback ? { fallbacks: 'default' } : {}),
      betas: ['thinking-binding-controls-2026-08-01', ...(fallback ? ['server-side-fallback-2026-07-01'] : [])],
      stream: true,
    }).asResponse();
    return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') || 'text/event-stream', 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return apiError(cors, 429, 'rate_limit_error', 'The AI helper is busy right now. Try again in a minute.');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return apiError(cors, 503, 'overloaded_error', 'The AI helper isn’t set up right (its API key was refused).');
    if (e instanceof Anthropic.BadRequestError) return apiError(cors, 400, 'invalid_request_error', 'The AI helper couldn’t read this chat. Start a new chat.');
    if (e instanceof Anthropic.APIError) return apiError(cors, 502, 'api_error', 'The AI helper had a problem. Try again in a moment.');
    return apiError(cors, 502, 'api_error', 'Couldn’t reach the AI service. Try again in a moment.');
  }
}
