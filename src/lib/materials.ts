/** Material library for mass/density estimation. Keys are stored on a body's
 * `material` field; `density` is g/cm³. Shared by the properties panel and the
 * right-click Material submenu. */
export const MATERIALS: Record<string, { name: string; density: number }> = {
  steel: { name: 'Steel', density: 7.85 },
  aluminum: { name: 'Aluminum', density: 2.70 },
  copper: { name: 'Copper', density: 8.96 },
  titanium: { name: 'Titanium', density: 4.51 },
  abs: { name: 'ABS', density: 1.04 },
  pla: { name: 'PLA', density: 1.24 },
  nylon: { name: 'Nylon', density: 1.14 },
  wood: { name: 'Wood (Oak)', density: 0.75 },
};
