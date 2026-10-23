import { tally } from './records.js';

// Controls for watching a replay, shown in a game's top bar: pause and play, one move at a time, and speed.
export function ReplayBar({ ctl }) {
  const pct = ctl.total ? Math.min(100, Math.round((100 * ctl.pos) / ctl.total)) : 0;
  return (
    <span className="replaybar" role="group" aria-label="Replay controls">
      <span className="chip gold">Replay</span>
      <button className="btn sm icon" onClick={() => ctl.setPaused(!ctl.paused)} disabled={ctl.ended} aria-label={ctl.paused ? 'Play' : 'Pause'} title={ctl.paused ? 'Play' : 'Pause'}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{ctl.paused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}</svg>
      </button>
      {ctl.paused && !ctl.ended ? <button className="btn sm" onClick={() => ctl.step()}>Next move</button> : null}
      <span className="seg" role="group" aria-label="Replay speed">{[1, 2, 4].map(s => <button key={s} className={ctl.speed === s ? 'on' : ''} aria-pressed={ctl.speed === s} onClick={() => ctl.setSpeed(s)}>{s}×</button>)}</span>
      <span className="replaypos" title={`${ctl.pos} of ${ctl.total} moves`}><i style={{ width: pct + '%' }} /><b>{ctl.ended ? 'Finished' : `${pct}%`}</b></span>
    </span>
  );
}

// your wins and losses with one deck, for the lobbies
export function DeckRecord({ kind, id }) {
  const t = tally(kind, id);
  if (!t.games) return null;
  return <p className="deckrec">Your record with this deck: <b className="w">{t.win} win{t.win === 1 ? '' : 's'}</b> · <b className="l">{t.loss} loss{t.loss === 1 ? '' : 'es'}</b>{t.draw ? <> · <b>{t.draw} draw{t.draw === 1 ? '' : 's'}</b></> : null}</p>;
}
