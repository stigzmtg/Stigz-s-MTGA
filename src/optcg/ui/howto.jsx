// How to play the One Piece Card Game, in short.
import { Modal } from '../../ui/dialogs.jsx';
import { resetTips } from '../../ui/coach.jsx';

export function HowToPlayOp({ onClose }) {
  return (
    <Modal label="How to play" onClose={onClose}>
      <h2>How to play</h2>
      <div className="help">
        <section><h3>Goal</h3><p>Each Leader starts with Life cards (usually 4 or 5). When your attack hits the opponent's Leader, they take a Life card into their hand. Hit their Leader once more after their Life is gone and you win. A player whose deck runs out also loses.</p></section>
        <section><h3>DON!!</h3><p>Each turn you get 2 more DON!! cards (the player going first gets 1 on their first turn). Rest DON!! to pay the cost of Characters, Events and Stages, or give DON!! to your Leader or a Character: each one adds 1000 power during your turn. Your DON!! come back at the start of your next turn.</p></section>
        <section><h3>Your turn</h3><p>Your cards stand up, you draw a card (not on the very first turn) and get your DON!!. Then play cards and attack in any order. Up to 5 Characters can be in play. Neither player can attack on their own first turn.</p></section>
        <section><h3>Attacking</h3><p>Rest your Leader or a Character to attack the opponent's Leader or one of their rested Characters. A new Character must wait a turn before it attacks, unless it has [Rush]. If the attacker's power is at least the defender's, the Leader loses a Life card or the Character is K.O.'d.</p></section>
        <section><h3>Defending</h3><p>When you're attacked, you may rest a [Blocker] to take the hit instead. Then you may play Counter cards: trash cards from your hand for the +1000 or +2000 printed on their side, or play [Counter] Events. A Life card with a [Trigger] can be used for free when it's taken.</p></section>
        <section><h3>Playing a friend</h3><p>Pick your deck, choose <b>Play with friends</b>, make a room and send your friend the invite link. They pick their own deck and take the second seat, then you start the battle. Anyone else who opens the link can watch.</p></section>
      </div>
      <div className="row"><button className="btn ghost" onClick={() => { resetTips('op'); onClose(); }}>Show tips again</button><button className="btn primary" onClick={onClose}>Got it</button></div>
    </Modal>
  );
}
