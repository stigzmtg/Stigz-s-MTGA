// The One Piece side of the site: load the starter decks, then lobby <-> battle.
import { OpLobby } from './lobby.jsx';
import { initOpImages, preloadOp } from './images.js';
import { fetchJSON, safeStorage } from '../../ui/common.js';
import { roomApi } from '../../net/roomclient.js';

const { useState, useEffect } = React;

// a One Piece room invite in the address: #op-abc123
export const opRoomFromHash = () => { const m = /^op-([a-z0-9]{6})$/.exec(location.hash.slice(1)); return m ? m[1] : null; };

export function OnePieceApp({ onHome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [api, setApi] = useState(undefined);
  const [mode, setMode] = useState(() => opRoomFromHash() ? 'friends' : (safeStorage.getItem('op-mode') || 'solo'));
  useEffect(() => {
    (async () => {
      try {
        const [cards, decks] = await Promise.all([fetchJSON('data/optcg/cards.json'), fetchJSON('data/optcg/decks.json')]);
        setData({ cards, decks });
      } catch (e) { setError(e.message); }
    })();
    initOpImages().then(ok => { if (ok) preloadOp(); });
    roomApi().then(a => setApi(a || null));
  }, []);
  useEffect(() => { safeStorage.setItem('op-mode', mode); }, [mode]);
  if (error) return <div className="app op"><div className="loading"><h2>Couldn't load the One Piece cards</h2><p>{error}</p><button className="btn" onClick={onHome}>Back</button></div></div>;
  if (!data) return <div className="app op"><div className="loading"><div className="label">Raising the sails</div><div className="bar"><i style={{ width: '60%' }} /></div></div></div>;
  const online = { api, room: null, mode, setMode, invite: opRoomFromHash(), nick: safeStorage.getItem('pa-nick') || '', onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onWatch() {}, onDeck() {} };
  return <OpLobby data={data} online={online} onStart={() => {}} onHome={onHome} onHelp={() => {}} />;
}
