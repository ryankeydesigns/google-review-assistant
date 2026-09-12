# Google Review Assistant — Hostinger Phase 2

Hostinger-compatible Node.js and MySQL edition of the RyanKey Designs multi-merchant Google Review Assistant.

## Hostinger settings

- Branch: `main`
- Node.js: 20 or newer
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`

Create a MySQL database in hPanel and add every variable from `.env.example` to the Hostinger Web App environment settings. Never commit real passwords.

The application creates its tables automatically on first successful startup. Merchant logos are stored inside MySQL so they survive application redeployments.

## URLs

- `/login` — administrator login
- `/admin` — dashboard
- `/admin/reports` — monthly merchant usage reports and CSV export
- `/admin/billing` — point balance, usage charges and manual top-ups
- `/r/:slug` — public merchant review assistant

Production URL: `https://google-review.ryankey.com.my`

The system does not select a rating or publish a Google review on behalf of a customer.

## Usage billing

- RM1 equals 1 point.
- Each first entry to a merchant review page deducts 1 point.
- Each review template added by an administrator deducts 10 points once.
- Manual top-up packages are RM100, RM500, RM800 and RM1,200.
- Generated review text is stored for monthly reporting; visitor identities are counted with a one-way anonymous hash rather than a raw IP address.
