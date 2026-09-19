/**
 * Case-insensitive substring filter for the browser tree search box
 * (Fusion's browser filter). A blank filter matches everything, so an empty
 * query leaves the tree exactly as it was. UI-free so both the BrowserTree
 * component and its tests can use it (component files must only export
 * components for react-refresh).
 */
export function matchesNameFilter(name: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}
