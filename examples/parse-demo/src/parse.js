export function parsePair(s) {
  const i = s.indexOf('=');
  if (i === -1) return { key: s, value: undefined };
  return { key: s.slice(0, i), value: s.slice(i + 1) };
}
