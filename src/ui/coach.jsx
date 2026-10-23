// Guided tips for your first games: a small card that explains what the table is asking right now. Each tip shows
// once; "Hide tips" turns them off for that game, and How to play can bring them back.
import { safeStorage } from './common.js';

const { useState } = React;
const KEY = 'pa-tips';
const load = () => { try { return JSON.parse(safeStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const save = s => safeStorage.setItem(KEY, JSON.stringify(s));

export function resetTips(kind) { const s = load(); delete s[kind]; save(s); }

// tips: [{ id, when, text }] in order of priority; the first one that applies and hasn't been seen shows
export function Coach({ kind, tips }) {
  const [st, setSt] = useState(() => load()[kind] || { off: false, seen: [] });
  if (st.off) return null;
  const tip = tips.find(t => t.when && !st.seen.includes(t.id));
  if (!tip) return null;
  const update = next => { const all = load(); all[kind] = next; save(all); setSt(next); };
  return (
    <aside className="coach" role="note" aria-label="Tip">
      <span className="coach-mark" aria-hidden="true">?</span>
      <div>
        <b>Tip</b>
        <p>{tip.text}</p>
        <span className="coach-acts">
          <button className="btn sm primary" onClick={() => update({ ...st, seen: [...st.seen, tip.id] })}>Got it</button>
          <button className="btn sm ghost" onClick={() => update({ ...st, off: true })}>Hide tips</button>
        </span>
      </div>
    </aside>
  );
}
