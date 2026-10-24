// One Piece card colors: a small dot (or a split dot for two-color Leaders) and the CSS color for each.
export const OP_COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
export const COLOR_HEX = { Red: '#d63c2f', Green: '#2e9b5a', Blue: '#2f73c6', Purple: '#8b4bb6', Black: '#34343c', Yellow: '#e6bf27' };

export function ColorDot({ colors, size = 14, title }) {
  const cs = (Array.isArray(colors) ? colors : [colors]).filter(c => COLOR_HEX[c]);
  if (!cs.length) return null;
  const bg = cs.length === 1 ? COLOR_HEX[cs[0]] : `linear-gradient(135deg, ${COLOR_HEX[cs[0]]} 0 50%, ${COLOR_HEX[cs[1]]} 50% 100%)`;
  return <span className="op-dot" style={{ width: size, height: size, background: bg }} title={title || cs.join(' / ')} aria-label={cs.join(' and ')} />;
}
