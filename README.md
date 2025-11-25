# WhatsApp Cloud Bot (MongoDB)

Node.js + Express bot for WhatsApp Cloud API. Stores sessions and appointments in MongoDB.

## Run locally
1. Copy `.env.template` → `.env` and fill values.
2. `npm install`
3. `npm run dev` (nodemon) or `npm start`

## Webhook endpoints
- `GET /webhook` — Meta verify
- `POST /webhook` — receive messages (JSON)

