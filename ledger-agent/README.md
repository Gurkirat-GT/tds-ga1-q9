# Acme Appliances Ledger Agent

This Vercel function accepts `POST /api/answer` with JSON
`{"question":"..."}` and returns `{"answer":...}`. It discovers the
personalized ledger export and currency rates, keeps the latest revision of
each order, applies the Asia/Kolkata business date, and counts only paid
orders as revenue. Refund questions use refunded orders.

## Deploy

Set the Vercel project root directory to `ledger-agent`, configure
`LEDGER_DISCOVERY_URL` for Production, Preview, and Development using the
personalized `/questionData?...&path=/` URL from the task, then deploy.

The public endpoint is `https://<deployment-domain>/api/answer`.
