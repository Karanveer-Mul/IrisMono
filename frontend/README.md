# IrisMono Frontend

Next.js 16 (App Router) client for the IrisMono medical image masking platform. Migrated from the original React + Vite SPA.

## Running

The Express API listens on **3000**, so this app runs on **3001** to avoid the collision.

```bash
npm install
npm run dev      # http://localhost:3001
```

`/api/*` is rewritten to the backend (`next.config.ts`), which keeps everything same-origin exactly as the old Vite proxy did — so the backend needs no CORS middleware. Point it elsewhere with `BACKEND_URL`:

```bash
BACKEND_URL=http://api.internal:3000 npm run dev
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`.

## Structure

```
app/
  layout.tsx            root layout, next/font (Inter + Outfit), metadata
  globals.css           design tokens and all component styles
  page.tsx              /
  join/[code]/page.tsx  /join/inv_<uuid> — invite landing
components/
  AppShell.tsx          session gate: Auth or Dashboard
  Auth.tsx              sign in / create workspace / join team
  Dashboard.tsx         credits, job history, SSE subscription
  MaskUploader.tsx      drag-drop upload, job status, result preview
  InviteManager.tsx     domain whitelist + reusable invite links (ORG_ADMIN)
lib/
  api.ts                fetch wrapper, JWT helpers
```

The JWT lives in `localStorage`, so every component that reads it is a client component.

Notable changes from the Vite version:

- **Invite links are a real route.** `Auth.tsx` used to parse `window.location.pathname` looking for `/join/`; that is now `app/join/[code]/page.tsx`, which passes the code down as a prop.
- **`apiFetch` serializes object bodies.** The old version passed plain objects straight to `fetch`, which stringified them to `[object Object]` — every POST from the UI was rejected by the backend's JSON parser. See `AUDIT.md`.
- **Fonts come from `next/font`** rather than a Google Fonts `<link>` in `index.html`.

## Known broken — blocked on the backend

Both are documented in `../AUDIT.md`; neither can be fixed from this side.

1. **Live job updates never arrive.** `GET /api/jobs/events` sits behind Bearer-only JWT middleware, and the `EventSource` API cannot set request headers, so the SSE stream 401s and closes immediately. The subscription is left wired up in `Dashboard.tsx` and will start working the moment the backend accepts a credential `EventSource` can carry. Meanwhile the dashboard stays usable because every mutation also refetches.
2. **Result images do not render.** The API exposes only `PUT /api/jobs/mock-upload/:jobId` and serves nothing for reading. `MaskUploader.tsx` points at the proposed `GET /api/jobs/:jobId/image/:kind` (AUDIT fix #2); until that route exists both preview panes fall back to a placeholder.

**Full end-to-end verification is blocked on AUDIT fix #1** — the backend does not currently compile, so the API cannot start at all.
