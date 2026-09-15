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
- `/admin/analytics` — daily, monthly and yearly usage, merchant growth, review-rate and completed top-up-rate charts
- `/admin/billing` — point balance, usage charges and manual top-ups
- `/client/:slug` — unique merchant login and dashboard URL
- `/client/:slug/merchant` — signed-in merchant profile
- `/client/:slug/reviews` — signed-in merchant review library
- `/client/:slug/reports` — signed-in merchant reports
- `/client/:slug/reports.csv?month=YYYY-MM` — signed-in merchant monthly CSV report
- `/r/:slug` — public merchant review assistant

Production URL: `https://google-review.ryankey.com.my`

The system does not select a rating or publish a Google review on behalf of a customer.

## Usage billing

- RM1 equals 1 point.
- Entering a merchant review page is recorded for administrator analytics but does not deduct points or appear as an individual report row.
- Each generated review deducts 1 point.
- The first three custom review templates per merchant are free; the fourth and each later addition deducts 10 points once.
- A merchant with 10 points or fewer cannot add another review template until the administrator credits a top-up.
- Merchant top-up requests are RM100/100 points, RM500/550 points, RM800/880 points, RM1,000/1,100 points and RM1,200/1,440 points.
- Top-up selections are recorded and open a WhatsApp request to the number configured in `ADMIN_WHATSAPP_NUMBER`, containing the merchant name, email, phone, package and points.
- Every completed administrator top-up record provides a WhatsApp success button with the fee, points, time, current balance and merchant review-library refresh link.
- Only the platform administrator can top up points or change a merchant's locked name, URL slug, login email and password.
- Merchant passwords are stored as salted scrypt hashes and can only be reset, never viewed.
- Administrator and multiple merchant identities can stay signed in simultaneously in the same browser session; each merchant login is isolated by its unique slug.
- Each merchant dashboard displays and downloads its own customer review QR Code.
- The administrator can reset a merchant password and receive a one-time copy/WhatsApp sharing panel containing the login URL, email and new password.
- Generated review text is stored for monthly reporting; visitor identities are counted with a one-way anonymous hash rather than a raw IP address.
