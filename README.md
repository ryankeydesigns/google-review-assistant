# Google Review Assistant

A mobile-first Google Review copy assistant by RyanKey Designs.

Customers can generate a review draft, copy it to their clipboard, and continue to the merchant's official Google Review page. The customer remains responsible for editing the text according to their real experience, choosing a rating, and publishing the review.

## Features

- Pure HTML, CSS and JavaScript
- Mobile-first responsive design
- Chinese and English review libraries
- Random review combinations
- Clipboard API with manual-copy fallback
- Same-page redirect to the official Google Review link
- Duplicate-click protection
- No database, login or paid API

## Merchant configuration

Edit the `merchantConfig` section at the top of `script.js`:

```javascript
const merchantConfig = {
  businessName: "Your Business Name",
  industry: "Your Industry",
  language: "zh",
  googleReviewLink: "OFFICIAL_GOOGLE_REVIEW_LINK",
  logo: "images/logo.svg",
  primaryColor: "#2563EB",
  poweredBy: "RyanKey Designs",
  isDemo: false,
  redirectDelayMs: 1300
};
```

Obtain the official review link from the merchant's Google Business Profile. Do not guess the link.

## Responsible use

Generated text is a draft only. Customers should revise it based on their genuine experience and choose their own rating. The system does not select stars, publish reviews, collect Google credentials, or store review content.

## Deployment

The repository can be published using GitHub Pages or any HTTPS web host. HTTPS is required for reliable clipboard access on mobile browsers.

Powered by [RyanKey Designs](https://ryankey.com.my/).
