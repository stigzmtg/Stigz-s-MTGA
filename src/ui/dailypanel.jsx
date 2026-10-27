// The daily challenge's panel in a lobby (daily.js): today's decks, how you did and your streak, and the button.
// art(deck) draws a deck's picture, about(deck) its second line; style(deck) colors its seat.
import { dailyChallenge, dailyStatus, dayKey } from './daily.js';

const { useMemo } = React;

export function DailyPanel({ kind, decks, art, about, style, onPlay }) {
  const key = dayKey();
  const daily = useMemo(() => dailyChallenge(decks, key, kind), [decks, key, kind]);
  const st = useMemo(() => dailyStatus(key, kind), [key, kind]);
  if (!daily) return null;
  const date = new Date(key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const players = daily.opps.length === 1 ? '1 vs 1' : `${daily.opps.length + 1}-player`;
  const seat = (d, you) => (
    <span key={d.id} className={`dseat ${you ? 'you' : ''}`} style={style ? style(d) : undefined}>
      {art(d)}
      <span className="dsn"><small>{you ? 'You play' : 'Against'}</small><b>{d.name}</b><span>{about(d)}</span></span>
    </span>
  );
  const status = st.today === 'win'
    ? <><b className="w">You won today’s game</b>{st.streak > 1 ? <>, <b>{st.streak} days in a row</b></> : ''}.</>
    : st.today ? <>Not won yet ({st.tries} {st.tries === 1 ? 'try' : 'tries'}){st.streak ? <>: win to make it <b>{st.streak + 1} days in a row</b></> : ''}.</>
    : st.streak ? <>Win to make it <b>{st.streak + 1} days in a row</b>.</> : <>A new one every day.</>;
  return (
    <section className="panel daily" aria-label="Daily challenge">
      <div className="daily-head"><h2>Daily challenge</h2><span className="chip gold">{date}</span><span className="chip">{players}</span></div>
      <div className="daily-seats">{seat(daily.mine, true)}{daily.opps.map(d => seat(d, false))}</div>
      <div className="daily-foot">
        <span className="note">Everyone gets this same game today: the same decks and the same shuffle. {status}</span>
        <button className="btn primary" onClick={() => onPlay(daily)}>{st.tries ? 'Play it again' : 'Play today’s game'}</button>
      </div>
    </section>
  );
}
