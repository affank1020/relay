## TypeScript-only source

Relay now uses **TypeScript for its HTTP server, browser frontend, shared API types and integration tests**:

- `src/server.ts` — Pi agent runtime, HTTP routes and streaming
- `src/client.ts` — browser UI and Basic Auth / localhost-token flows
- `src/shared.ts` — shared session and streaming response interfaces
- `tests/*.test.ts` — browser auth tests plus a real Pi session smoke test
- `tsconfig.json` — strict typechecking

No JavaScript source files are maintained in Git. `npm run check` typechecks, `npm run build` compiles both targets using esbuild, and `npm test` exercises the production bundles. The generated `dist/server.js` and `dist/public/app.js` files are ignored and recreated during CI and Docker builds. Browsers and Node execute the generated JavaScript (they cannot directly execute TypeScript source in this deployment).

The production Docker image contains only the compiled bundles, static HTML/CSS, and runtime dependencies. The existing GitHub Actions deployment continues to build and deploy this Docker image automatically after a successful `Verify` on main.

~~~bash
npm install
npm run check
npm run build
npm test
~~~
