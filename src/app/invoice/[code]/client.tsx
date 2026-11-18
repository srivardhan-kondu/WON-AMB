"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorNote, Spinner } from "@/components/ui";
import { api } from "@/lib/client";
import { fmtDay, fmtMin, rupees } from "@/lib/time";

interface Invoice {
  number: string;
  issuedAt: number;
  gst: { total: number; taxable: number; cgst: number; sgst: number; rate: number };
  code: string;
  day: string;
  start: number;
  party: number;
  product: string;
  customer: string;
  paidPaise: number;
  seller: { name: string; address: string; gstin: string };
}

export default function InvoicePage() {
  const { code } = useParams<{ code: string }>();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t") ?? "";
    api<Invoice>(`/api/invoices/${code}?t=${encodeURIComponent(t)}`).then(setInv).catch((e: Error) => setErr(e.message));
  }, [code]);

  if (err) return <main className="p-6"><ErrorNote error={err} /></main>;
  if (!inv) return <main className="p-6"><Spinner /></main>;

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <div className="rounded-2xl bg-white p-8 text-black">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-2xl font-black">TAX INVOICE</div>
            <div className="text-sm">{inv.seller.name}</div>
            <div className="text-sm">{inv.seller.address}</div>
            <div className="text-sm">GSTIN: {inv.seller.gstin}</div>
          </div>
          <div className="text-right text-sm">
            <div className="font-mono font-semibold">{inv.number}</div>
            <div>{new Date(inv.issuedAt).toLocaleDateString("en-IN")}</div>
            <div>Booking {inv.code}</div>
          </div>
        </div>
        <div className="mt-6 text-sm">Billed to: {inv.customer || "Guest"}</div>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-black/20 text-left">
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-black/10">
              <td className="py-2">
                {inv.product} × {inv.party} — {fmtDay(inv.day)}, {fmtMin(inv.start)}
                <div className="text-xs text-black/60">SAC 999652 · Amusement & recreation services</div>
              </td>
              <td className="py-2 text-right font-mono">{rupees(inv.gst.taxable)}</td>
            </tr>
            <tr>
              <td className="py-1 text-right">CGST {inv.gst.rate / 2}%</td>
              <td className="py-1 text-right font-mono">{rupees(inv.gst.cgst)}</td>
            </tr>
            <tr>
              <td className="py-1 text-right">SGST {inv.gst.rate / 2}%</td>
              <td className="py-1 text-right font-mono">{rupees(inv.gst.sgst)}</td>
            </tr>
            <tr className="border-t border-black/20 font-semibold">
              <td className="py-2 text-right">Total (GST inclusive)</td>
              <td className="py-2 text-right font-mono">{rupees(inv.gst.total)}</td>
            </tr>
            <tr>
              <td className="py-1 text-right text-black/60">Paid</td>
              <td className="py-1 text-right font-mono text-black/60">{rupees(inv.paidPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button className="btn no-print mt-4" onClick={() => window.print()}>
        Print / save PDF
      </button>
    </main>
  );
}
