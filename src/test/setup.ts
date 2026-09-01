// Node 24+ ships an experimental global `localStorage` that throws without
// --localstorage-file and, being a globalThis accessor, shadows the working
// one the jsdom environment provides (vitest's populateGlobal cannot replace
// it either). Expose a jsdom-backed Storage explicitly.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
if (typeof g.localStorage !== 'object' || g.localStorage === null) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage,
    configurable: true,
    writable: true,
  })
}
if (typeof g.sessionStorage !== 'object' || g.sessionStorage === null) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: dom.window.sessionStorage,
    configurable: true,
    writable: true,
  })
}
