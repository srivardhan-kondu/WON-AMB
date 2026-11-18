// PaymentProvider interface (§8). Razorpay when keys are set; otherwise a mock provider so the full
// hold → pay → webhook-confirm loop can be exercised locally. Swapping providers touches only this file.

import crypto from "node:crypto";

export interface PaymentProvider {
  name: "razorpay" | "mock";
  publicKey: string | null;
  createOrder(amountPaise: number, receipt: string): Promise<{ orderId: string }>;
  verifyWebhook(rawBody: string, signature: string | null): boolean;
  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean;
  refund(paymentId: string, amountPaise: number): Promise<{ refundId: string }>;
}

function hmac(secret: string, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class RazorpayProvider implements PaymentProvider {
  name = "razorpay" as const;
  constructor(
    private keyId: string,
    private keySecret: string,
    private webhookSecret: string,
  ) {}
  get publicKey() {
    return this.keyId;
  }
  private auth() {
    return "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
  }
  async createOrder(amountPaise: number, receipt: string) {
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt, payment_capture: 1 }),
    });
    if (!r.ok) throw new Error(`Razorpay order failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { id: string };
    return { orderId: j.id };
  }
  verifyWebhook(rawBody: string, signature: string | null) {
    return !!signature && safeEq(hmac(this.webhookSecret, rawBody), signature);
  }
  verifyCheckout(orderId: string, paymentId: string, signature: string) {
    return safeEq(hmac(this.keySecret, `${orderId}|${paymentId}`), signature);
  }
  async refund(paymentId: string, amountPaise: number) {
    const r = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: "POST",
      headers: { Authorization: this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ amount: amountPaise }),
    });
    if (!r.ok) throw new Error(`Razorpay refund failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { id: string };
    return { refundId: j.id };
  }
}

class MockProvider implements PaymentProvider {
  name = "mock" as const;
  publicKey = null;
  async createOrder() {
    return { orderId: "mock_order_" + crypto.randomBytes(6).toString("hex") };
  }
  verifyWebhook() {
    return true;
  }
  verifyCheckout() {
    return true;
  }
  async refund() {
    return { refundId: "mock_refund_" + crypto.randomBytes(4).toString("hex") };
  }
}

let provider: PaymentProvider | null = null;
export function payments(): PaymentProvider {
  if (provider) return provider;
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;
  provider =
    RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET
      ? new RazorpayProvider(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET)
      : new MockProvider();
  return provider;
}
