export function parsePair(s) {
  const [key, value] = s.split('=');
  return { key, value };
}
