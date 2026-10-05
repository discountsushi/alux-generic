// Page-wide state (the pods' last snapshot) plus a tiny event bus.
export const store = { pods: null };

const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
