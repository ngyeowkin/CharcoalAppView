# view — Charcoal Run app (Vue 3 + Vite)

The driver uses it on his phone; you and the admin use it on a laptop (or phone).
It talks to the Rails `../api` and checks for changes every 8 seconds, so the office
sees the driver's updates and the driver sees new orders without refreshing.

## Run on your Mac

```bash
cd view
npm install
cp .env.example .env.local     # VITE_API_URL=http://localhost:3000
npm run dev                    # http://localhost:5173
```

## What's where

| File | What |
|---|---|
| `src/engine/engine.js` | All the Charcoal Run screens and logic, ported from the prototype — driver run, tabulate, master grid, deliveries, inventory, invoices, unpaid, bills & photos, statistics, restaurants, WA orders, activity |
| `src/engine/engine.css` | The prototype's styles (light and dark) |
| `src/engine/company.js` | Company name, reg no., bank and PayNow details printed on invoices |
| `src/views/` | Sign-in, the app shell, and the Team (logins) page |
| `src/api.js` | Talking to the server |

## Deploy to Cloudflare Pages

Cloudflare dashboard → Workers & Pages → Create → Pages → connect the GitHub repo:

- Root directory: `view`
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variable: `VITE_API_URL = https://api.sgcharcoal.com` (your Rails server)

Or from your Mac: `VITE_API_URL=https://api.sgcharcoal.com npm run deploy`.

On the server set `CORS_ORIGINS` to the Pages address. On the driver's phone, open the
site and "Add to Home Screen".
# CharcoalAppView
# CharcoalAppView
