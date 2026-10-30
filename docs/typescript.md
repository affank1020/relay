## TypeScript-only source

Relay now uses **TypeScript for its HTTP server, browser frontend, shared API types and integration tests**:

- `src/server.ts` — Pi agent runtime and process entrypoint
- `src/application.ts` — HTTP routes, streaming and bounded request admission
- `src/client.ts` — browser UI and Basic Auth / localhost-token flows
- `src/shared.ts` — shared session and streaming response interfaces
- `src/healthcheck.ts` — Docker health probe (no inline JavaScript in Compose)
- `tests/*.test.ts` — browser auth tests plus a real Pi session smoke test
- `tsconfig.json` — strict typechecking

No JavaScript source files are maintained in Git. `npm run check` typechecks, `npm run build` compiles both targets using esbuild, and `npm test` exercises the production bundles. The generated `dist/server.js` and `dist/public/app.js` files are ignored and recreated during CI and Docker builds. Browsers and Node execute the generated JavaScript (they cannot directly execute TypeScript source in this deployment).

The production Docker image contains only the compiled bundles, static HTML/CSS, and runtime dependencies. The existing GitHub Actions deployment continues to build and deploy this Docker image automatically after a successful `Verify` on main.

~~~bash
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run verify
~~~
