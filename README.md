# Lumonex WhatsApp Chatbot (Multi-clinic)

## Quick setup
1. `git clone` this repo.
2. `cp .env.example .env` and edit `.env` (fill MONGO_URI, WHATSAPP_TOKEN, WEBHOOK_VERIFY_TOKEN, CLINICS_JSON).
   - **Important:** DO NOT commit `.env` to git. Add `.env` to `.gitignore`.
3. `npm install`
4. `npm start` (or `npm run dev` during development)

## Notes
- `CLINICS_JSON` should be a valid JSON array. Use your host's secret manager (Render/Heroku) for storing this env var.
- The webhook endpoint is `/webhook`. Configure this in Meta Business Manager and use `WEBHOOK_VERIFY_TOKEN`.
- The incoming webhook is shared by all clinics. The code maps the incoming `metadata.phone_number_id` to the clinic in `CLINICS_JSON`.

## CRM endpoints
- `GET /crm/:clinicId/records` — list records for a clinic.
- `GET /crm/:clinicId/record/:id` — get a single record.
- `POST /crm/:clinicId/record` — create a record manually (staff).
- `PUT /crm/:clinicId/record/:id` — update record (staff).

## Staff notifications
- When a new booking is created via WhatsApp or manually, the clinic staff is notified via WhatsApp to `contactNumber` of that clinic.

## Security checklist
- Do NOT push `.env` to GitHub. Use host environment variables.
- Add auth to CRM endpoints (API key or OAuth) before exposing to staff.
- Consider enabling HTTPS and verified webhook URL in Meta Business Manager.

## Next steps (optional)
- Add CRM frontend (React) that calls the endpoints.
- Add authentication for staff (JWT / API key).
- Add email notifications as fallback.
- Add audit logs for edits.
