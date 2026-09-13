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
- `/client/login` — separate merchant customer login
- `/client/login/:slug` — merchant-specific customer login URL
- `/client` — merchant dashboard for profile, review library and reports
- `/client/reports.csv?month=YYYY-MM` — signed-in merchant monthly CSV report
- `/r/:slug` — public merchant review assistant

Production URL: `https://google-review.ryankey.com.my`

The system does not select a rating or publish a Google review on behalf of a customer.

## Usage billing

- RM1 equals 1 point.
- Each first entry to a merchant review page deducts 1 point.
- The first three custom review templates per merchant are free; the fourth and each later addition deducts 10 points once.
- Manual top-up packages are RM100, RM500, RM800 and RM1,200.
- Only the platform administrator can top up points or change a merchant's locked name, URL slug, login email and password.
- Merchant passwords are stored as salted scrypt hashes and can only be reset, never viewed.
- Administrator and merchant identities can stay signed in simultaneously in the same browser session.
- The administrator can reset a merchant password and receive a one-time copy/WhatsApp sharing panel containing the login URL, email and new password.
- Generated review text is stored for monthly reporting; visitor identities are counted with a one-way anonymous hash rather than a raw IP address.
