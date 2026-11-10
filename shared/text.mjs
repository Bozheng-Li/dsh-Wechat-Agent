export function searchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}
