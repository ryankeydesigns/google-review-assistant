# Google Review Assistant — Phase 2 Admin

Multi-merchant Google Review management platform by RyanKey Designs.

## Features

- Central merchant dashboard
- Merchant profile, branding and official Google Review link management
- Chinese, English and Bahasa Melayu review templates
- Merchant-specific public review pages and downloadable QR codes
- Scan, review-generation and Google-redirect statistics
- D1 database, R2 logo storage and owner-protected admin routes
- Mobile-first customer experience with Clipboard API fallback

## Important deployment note

This Phase 2 application requires server-side authentication, Cloudflare D1 and R2. It cannot run as a full application on GitHub Pages. GitHub Pages continues to serve the Phase 1 static demo from the repository's `main` branch.

The public test application is hosted at:

https://google-review-assistant-demo.hazy-river-2109.chatgpt.site

## Setup

1. Install dependencies with pnpm.
2. Generate and apply the Drizzle migration.
3. Configure the logical `DB` and `BUCKET` bindings in `.openai/hosting.json`.
4. Replace `REPLACE_WITH_SITE_OWNER_USER_ID` in `lib/admin-auth.ts` with the authenticated owner ID for the target Site.
5. Build and deploy using a compatible Vinext / Cloudflare Workers environment.

Do not guess a merchant's Google Review URL. Always use the official link supplied through Google Business Profile.

Powered by [RyanKey Designs](https://ryankey.com.my/).
