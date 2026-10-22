// Energy type symbols, drawn as small SVG glyphs in type-colored discs.
export const TYPE_COLORS = {
  Grass: '#4fae4a', Fire: '#e8572c', Water: '#2b8fd6', Lightning: '#f3c21b', Psychic: '#9c5bbd', Fighting: '#c0652d',
  Darkness: '#33404c', Metal: '#8d99a3', Dragon: '#b4952d', Colorless: '#ddd8c8',
};
const GLYPH = {
  Grass: 'M12 3c-5 3-7 7-6 11 1 3 3 5 6 6 0-4 1-8 4-11-2 3-3 6-3 10 4-2 6-6 5-10-1-3-3-5-6-6z',
  Fire: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 2 1 3 2 4 1-3 0-6 1-9z',
  Water: 'M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z',
  Lightning: 'M13 2L5 14h6l-2 8 9-12h-6l1-8z',
  Psychic: 'M2 12c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7s-7-2-10-7zm10-4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  Fighting: 'M6 9a2 2 0 0 1 4 0V7a2 2 0 0 1 4 0v1a2 2 0 0 1 4 1v6c0 4-3 6-6 6H9c-2 0-4-2-4-4v-3a2 2 0 0 1 1-2V9z',
  Darkness: 'M15 3a9 9 0 1 0 6 13A8 8 0 0 1 15 3z',
  Metal: 'M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  Dragon: 'M4 18c3-1 5-4 6-8l-3 1 5-7 1 5 3-2-1 5c3 0 5 2 5 5-3-2-6-2-9 0-2 1-4 2-7 1z',
  Colorless: 'M12 2l2.6 6.9L22 10l-5.6 4.6L18 22l-6-4-6 4 1.6-7.4L2 10l7.4-1.1L12 2z',
};
export function Energy({ type, size = 18, title }) {
  const t = GLYPH[type] ? type : 'Colorless';
  const dark = t === 'Lightning' || t === 'Colorless';
  return (
    <span className="pk-en" style={{ '--en': TYPE_COLORS[t], width: size, height: size }} title={title || `${t} Energy`} aria-label={`${t} Energy`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPH[t]} fill={dark ? '#3a3220' : '#fff'} /></svg>
    </span>
  );
}
export function Cost({ cost, size = 16 }) {
  if (!cost || !cost.length) return <span className="pk-cost free">free</span>;
  return <span className="pk-cost">{cost.map((t, i) => <Energy key={i} type={t} size={size} />)}</span>;
}
