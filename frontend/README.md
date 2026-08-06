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

## Two things worth knowing

**Live updates use a separate token.** `EventSource` cannot set an `Authorization` header, so `Dashboard.tsx` first calls `POST /api/auth/stream-token` for a 60-second token and passes it to the stream as `?token=`. That token is scoped to the stream — the API refuses it as a Bearer credential.

**Job images are fetched as blobs.** `GET /api/jobs/:jobId/image/:kind` is tenant-scoped behind the normal session, which an `<img src>` cannot satisfy, so `JobImage.tsx` fetches the bytes with the token attached and renders an object URL.

## Running the whole stack

The backend needs Postgres and RabbitMQ:

```bash
cd ../backend
docker compose up -d
npm run db:migrate
npm run dev          # API on :3000
npm run worker:dev   # GPU worker, separate terminal
```

Then `npm run dev` here for the UI on :3001.
