/**
 * Velxio-local custom elements.
 *
 * These are wokwi-style web components that live IN this project rather
 * than in the upstream `@wokwi/elements` package — useful when we don't
 * have push access to wokwi/wokwi-elements but still need to ship new
 * parts (e.g. `<wokwi-capacitor>`, `<wokwi-inductor>` for SPICE).
 *
 * Side-effect import: each module calls `customElements.define(...)` at
 * load time (guarded against double-registration), so a single
 * `import './wokwi-custom';` is enough to make the tags resolvable.
 */

import './capacitor-element';
import './capacitor-electrolytic-element';
import './inductor-element';

export { CapacitorElement } from './capacitor-element';
export { CapacitorElectrolyticElement } from './capacitor-electrolytic-element';
export { InductorElement } from './inductor-element';
