import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError, handle } from "@/lib/http";
import { audit } from "@/lib/repo";
import { nowIST } from "@/lib/time";

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const inr = (p: number) => (p / 100).toFixed(2);

/** Monthly invoice register for the accountant (§9): sequential numbers, GST-inclusive split. */
export const GET = handle(async (req: NextRequest) => {
  const staff = await requireStaff("manager");
  const month = req.nextUrl.searchParams.get("month") || nowIST().day.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "month must be YYYY-MM");
  // Invoice date in IST; created_at is epoch ms.
  const rows = await db()
    .prepare(
      `SELECT i.number, i.created_at, i.gst_detail, b.code, b.day, b.status, b.party_size, b.payment_method, b.paid_paise, b.refunded_paise, p.name AS product, c.name AS customer, c.phone
       FROM invoices i JOIN bookings b ON b.id = i.booking_id JOIN products p ON p.id = b.product_id LEFT JOIN customers c ON c.id = b.customer_id
       WHERE to_char(to_timestamp(i.created_at / 1000.0) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = ?
       ORDER BY i.fy, i.seq`,
    )
    .all(month) as { number: string; created_at: number; gst_detail: string; code: string; day: string; status: string; party_size: number; payment_method: string; paid_paise: number; refunded_paise: number; product: string; customer: string; phone: string }[];
  const header = ["Invoice No", "Invoice Date", "Booking", "Visit Date", "Customer", "Phone", "Description", "Qty", "SAC", "Taxable Value", "CGST 9%", "SGST 9%", "Invoice Total", "Paid", "Refunded (credit note due)", "Payment Method", "Booking Status"];
  const lines = [header.join(",")];
  const tot = { taxable: 0, cgst: 0, sgst: 0, total: 0 };
  for (const r of rows) {
    const g = JSON.parse(r.gst_detail) as { total: number; taxable: number; cgst: number; sgst: number };
    tot.taxable += g.taxable; tot.cgst += g.cgst; tot.sgst += g.sgst; tot.total += g.total;
    const date = new Date(r.created_at + 330 * 60_000).toISOString().slice(0, 10);
    lines.push([r.number, date, r.code, r.day, r.customer, r.phone, r.product, r.party_size, "999652", inr(g.taxable), inr(g.cgst), inr(g.sgst), inr(g.total), inr(r.paid_paise), inr(r.refunded_paise), r.payment_method, r.status].map(csv).join(","));
  }
  lines.push(["TOTAL", "", "", "", "", "", "", "", "", inr(tot.taxable), inr(tot.cgst), inr(tot.sgst), inr(tot.total), "", "", "", ""].join(","));
  await audit(staff.email, "gst_export", month, { invoices: rows.length });
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="won-gst-${month}.csv"` },
  });
});
