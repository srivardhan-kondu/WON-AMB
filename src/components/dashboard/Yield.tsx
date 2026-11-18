"use client";

import { useEffect, useState } from "react";
import type { Product } from "@/lib/engine/types";
import { api } from "@/lib/client";
import { addDays, fmtDay, fmtMin, nowIST, rupees, todayIST } from "@/lib/time";
import { ErrorNote, Field, Spinner } from "@/components/ui";
import { atLeast, useStaff } from "@/components/StaffShell";
import { PinDialog } from "@/components/PinDialog";

interface Flash {
  id: number;
  day: string;
  product_id: string;
  start_hour: number;
  end_hour: number;
  price_paise: number;
  auto: number;
  created_by: string;
  min_party: number;
}
interface YieldSettings {
  flashAuto: boolean;
  flashProduct: string;
  flashPricePaise: number;
  flashThreshold: number;
  flashHours: [number, number];
  memberPeakHorizonDays: number;
  memberOffpeakHorizonDays: number;
}

/** §8.5 dead-slot flash offers + §7 member horizon + GST export. */
export function Yield() {
  const staff = useStaff();
  const owner = atLeast(staff, "owner");
  const [products, setProducts] = useState<Product[]>([]);
  const [offers, setOffers] = useState<Flash[] | null>(null);
  const [settings, setSettings] = useState<YieldSettings | null>(null);
  const [form, setForm] = useState({ date: addDays(todayIST(), 1), product: "c3", startHour: 11, endHour: 13, price: "799", minParty: 1 });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [v, setV] = useState(0);
  const [month, setMonth] = useState(nowIST().day.slice(0, 7));

  useEffect(() => {
    api<{ products: Product[] }>("/api/admin/products").then((d) => setProducts(d.products.filter((p) => p.pricing === "pp" && p.shape !== "party")));
    api<YieldSettings>("/api/yield-settings").then(setSettings);
  }, []);
  useEffect(() => {
    api<{ offers: Flash[] }>("/api/flash-offers").then((d) => setOffers(d.offers));
  }, [v]);

  async function open() {
    setErr(null);
    try {
      await api("/api/flash-offers", { body: { date: form.date, product: form.product, startHour: form.startHour, endHour: form.endHour, pricePaise: Math.round(Number(form.price) * 100), minParty: form.minParty } });
      setV((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function close(id: number) {
    await api(`/api/flash-offers/${id}`, { method: "DELETE" });
    setV((x) => x + 1);
  }
  async function saveSettings() {
    if (!settings) return;
    setErr(null);
    try {
      setSettings(await api<YieldSettings>("/api/yield-settings", { method: "PUT", body: settings }));
      setMsg("Saved");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-5">
      <ErrorNote error={err} />
      <div className="card space-y-3">
        <div className="font-semibold">Flash prices (next 15 days)</div>
        <p className="text-sm text-muted">Off-peak only — the engine refuses to apply a flash price to a peak hour. Bookings already sold keep their price.</p>
        {!offers ? (
          <Spinner />
        ) : offers.length === 0 ? (
          <div className="text-sm text-muted">No flash prices open.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {offers.map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <td className="py-2">{fmtDay(o.day)}</td>
                  <td>
                    {fmtMin(o.start_hour * 60)}–{fmtMin(o.end_hour * 60)}
                  </td>
                  <td>{name(o.product_id)}</td>
                  <td className="font-mono text-lime">
                    {rupees(o.price_paise)}/pp{o.min_party > 1 && <span className="ml-1 text-xs text-muted">groups of {o.min_party}+</span>}
                  </td>
                  <td className="text-xs text-muted">{o.auto ? "auto (D-1 < threshold)" : o.created_by}</td>
                  <td className="text-right">
                    <button className="btn btn-sm btn-danger" onClick={() => close(o.id)}>
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Date">
            <input type="date" className="input" value={form.date} min={todayIST()} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Product">
            <select className="input" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({rupees(p.pricePaise)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input type="number" className="input w-20" min={0} max={23} value={form.startHour} onChange={(e) => setForm({ ...form, startHour: Number(e.target.value) })} />
          </Field>
          <Field label="To">
            <input type="number" className="input w-20" min={1} max={24} value={form.endHour} onChange={(e) => setForm({ ...form, endHour: Number(e.target.value) })} />
          </Field>
          <Field label="Price ₹/pp">
            <input className="input w-24" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Min group" hint="e.g. 10 for a schools/colleges rate">
            <input type="number" className="input w-20" min={1} max={40} value={form.minParty} onChange={(e) => setForm({ ...form, minParty: Number(e.target.value) })} />
          </Field>
          <button className="btn btn-primary" onClick={open}>
            Open flash price
          </button>
        </div>
      </div>

      {settings && (
        <div className="card space-y-3">
          <div className="font-semibold">Automatic rules {!owner && <span className="text-xs text-muted">(owner can edit)</span>}</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!owner} checked={settings.flashAuto} onChange={(e) => setSettings({ ...settings, flashAuto: e.target.checked })} />
            Auto-open a flash price at 8 pm for tomorrow&apos;s weekday hours under
            <input type="number" disabled={!owner} className="input w-16" value={Math.round(settings.flashThreshold * 100)} onChange={(e) => setSettings({ ...settings, flashThreshold: Number(e.target.value) / 100 })} />% game-zone utilization
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Product">
              <select className="input" disabled={!owner} value={settings.flashProduct} onChange={(e) => setSettings({ ...settings, flashProduct: e.target.value })}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Flash ₹/pp">
              <input className="input w-24" disabled={!owner} value={settings.flashPricePaise / 100} onChange={(e) => setSettings({ ...settings, flashPricePaise: Math.round(Number(e.target.value) * 100) })} />
            </Field>
            <Field label="Window from">
              <input type="number" className="input w-20" disabled={!owner} value={settings.flashHours[0]} onChange={(e) => setSettings({ ...settings, flashHours: [Number(e.target.value), settings.flashHours[1]] })} />
            </Field>
            <Field label="to">
              <input type="number" className="input w-20" disabled={!owner} value={settings.flashHours[1]} onChange={(e) => setSettings({ ...settings, flashHours: [settings.flashHours[0], Number(e.target.value)] })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Member booking horizon — peak (days)">
              <input type="number" className="input w-24" disabled={!owner} value={settings.memberPeakHorizonDays} onChange={(e) => setSettings({ ...settings, memberPeakHorizonDays: Number(e.target.value) })} />
            </Field>
            <Field label="— off-peak (days)">
              <input type="number" className="input w-24" disabled={!owner} value={settings.memberOffpeakHorizonDays} onChange={(e) => setSettings({ ...settings, memberOffpeakHorizonDays: Number(e.target.value) })} />
            </Field>
            {owner && (
              <button className="btn btn-primary" onClick={saveSettings}>
                Save rules
              </button>
            )}
            {msg && <span className="text-sm text-lime">{msg}</span>}
          </div>
        </div>
      )}

      <RefundCard />

      <div className="card flex flex-wrap items-end gap-2">
        <div className="w-full font-semibold">GST invoice register</div>
        <Field label="Month">
          <input type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <a className="btn btn-cyan" href={`/api/admin/gst-export?month=${month}`}>
          Download CSV for accountant
        </a>
      </div>
    </div>
  );
}

/** §8 owner-approved refund exception. Policy is no refunds; the OWNER's PIN is required, and it is audited. */
function RefundCard() {
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [cancel, setCancel] = useState(true);
  const [booking, setBooking] = useState<{ code: string; status: string; paidPaise: number; refundedPaise: number; product: { name: string }; day: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function lookup() {
    setErr(null);
    setDone(null);
    try {
      const c = code.trim().toUpperCase().replace(/^(?!WON-)/, "WON-");
      const b = await api<NonNullable<typeof booking>>(`/api/bookings/${c}`);
      setBooking(b);
      setAmount(String((b.paidPaise - b.refundedPaise) / 100));
    } catch (e) {
      setBooking(null);
      setErr((e as Error).message);
    }
  }
  async function refund(pin: string, reason: string) {
    if (!booking) return;
    try {
      const r = await api<{ refundedPaise: number; via: string }>(`/api/bookings/${booking.code}/refund`, {
        body: { amountPaise: Math.round(Number(amount) * 100), reason, cancel, managerPin: pin },
      });
      setAsking(false);
      setDone(`Refunded ${rupees(r.refundedPaise)} ${r.via === "gateway" ? "to the original payment" : "— hand it back at the counter"}`);
      setBooking(null);
      setCode("");
    } catch (e) {
      setPinErr((e as Error).message);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="font-semibold">Refund exception (owner)</div>
      <p className="text-sm text-muted">Bookings are non-refundable. Use this only for an owner-approved exception. Online payments go back through Razorpay; cash/UPI counter payments are recorded for you to hand back.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Booking code">
          <input className="input font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} placeholder="WON-XXXX" />
        </Field>
        <button className="btn" disabled={code.length < 4} onClick={lookup}>
          Look up
        </button>
      </div>
      {booking && (
        <div className="space-y-2 rounded-xl bg-panel-2 p-3 text-sm">
          <div>
            {booking.code} · {booking.product.name} · {fmtDay(booking.day)} · {booking.status} · paid {rupees(booking.paidPaise)}
            {booking.refundedPaise > 0 && ` · already refunded ${rupees(booking.refundedPaise)}`}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Refund ₹">
              <input className="input w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cancel} onChange={(e) => setCancel(e.target.checked)} /> Also cancel the booking (frees the seats)
            </label>
            <button className="btn btn-danger" disabled={!(Number(amount) > 0)} onClick={() => { setPinErr(null); setAsking(true); }}>
              Refund…
            </button>
          </div>
        </div>
      )}
      {done && <div className="text-sm text-lime">{done}</div>}
      <ErrorNote error={err} />
      {asking && <PinDialog title={`Refund ${rupees(Math.round(Number(amount) * 100))} on ${booking?.code}: owner PIN`} needReason onSubmit={refund} onClose={() => setAsking(false)} error={pinErr} />}
    </div>
  );
}
