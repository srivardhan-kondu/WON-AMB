// Messenger interface (§8): WhatsApp Business Cloud API template messages when configured,
// otherwise logged to the `messages` outbox (visible in the owner dashboard) so flows are testable.

import { db } from "./db";

export type Template = "booking_confirmed" | "visit_reminder" | "waitlist_offer" | "party_summary" | "membership_update" | "otp" | "booking_apology";

export async function sendMessage(phone: string, template: Template, params: Record<string, string>) {
  const d = db();
  const info = d
    .prepare("INSERT INTO messages (to_phone, template, payload, status, created_at) VALUES (?, ?, ?, 'queued', ?)")
    .run(phone, template, JSON.stringify(params), Date.now());
  const id = Number(info.lastInsertRowid);
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    d.prepare("UPDATE messages SET status = 'mock' WHERE id = ?").run(id);
    if (process.env.NODE_ENV !== "production") console.log(`[whatsapp:mock] → ${phone} ${template}`, params);
    return;
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone.replace("+", ""),
        type: "template",
        template: {
          name: template,
          language: { code: "en" },
          components: [{ type: "body", parameters: Object.values(params).map((text) => ({ type: "text", text })) }],
        },
      }),
    });
    const j = (await r.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    d.prepare("UPDATE messages SET status = 'sent', provider_id = ? WHERE id = ?").run(j.messages?.[0]?.id ?? null, id);
  } catch (e) {
    d.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(String(e), id);
  }
}

export function baseUrl(): string {
  return (process.env.WON_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}
