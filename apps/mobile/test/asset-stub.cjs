// Vite turns `import logo from './x.svg'` into a URL string. ts-jest has no
// equivalent, so asset imports resolve to this stub. Components under test
// assert that an `<img src>` is rendered with the right alt text, never what
// the URL is — that side is covered by the build's manifest guard.
module.exports = 'test-asset-stub';
