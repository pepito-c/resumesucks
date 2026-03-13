# ResumeSucks.com

> Your Resume Sucks. Let Us Prove It.

AI-powered brutal resume critique + full rewrite tailored to your target job. $12 one-time.

## Live

**https://resumesucks.com**

## Stack

- Node/Express backend
- Stripe Checkout ($12/roast)
- Claude AI (brutally honest career coach prompt)
- Dark theme, red branding

## Setup

```bash
cp .env.example .env
# Add your keys to .env
npm install
npm start
```

## Environment Variables

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

## Deploy

Hosted on Railway. To deploy:

```bash
railway up --detach
```

## Known TODOs

- [ ] Persist jobs to disk (currently in-memory, lost on restart)
- [ ] Email delivery of results (capture email at Stripe checkout)
- [ ] Result page polling/retry loop
- [ ] Social sharing button
- [ ] Sample roast on landing page
- [ ] Set up real Stripe webhook
