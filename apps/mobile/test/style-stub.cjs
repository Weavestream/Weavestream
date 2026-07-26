// Vite resolves CSS and font imports; ts-jest does not. Specs that render
// a component which imports a stylesheet land here instead of failing to
// resolve the module.
module.exports = {};
