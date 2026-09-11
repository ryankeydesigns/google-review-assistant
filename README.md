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
- `/r/:slug` — public merchant review assistant

Production URL: `https://google-review.ryankey.com.my`

The system does not select a rating or publish a Google review on behalf of a customer.
