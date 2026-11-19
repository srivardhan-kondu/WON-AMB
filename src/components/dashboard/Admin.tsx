"use client";

import { useEffect, useState } from "react";
import type { Product } from "@/lib/engine/types";
import { api } from "@/lib/client";
import { ErrorNote, Field, Spinner } from "@/components/ui";
import { addDays, fmtDay, rupees, todayIST } from "@/lib/time";
import { atLeast, useStaff } from "@/components/StaffShell";

export function ProductsEditor() {
  const staff = useStaff();
  const owner = atLeast(staff, "owner");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [edits, setEdits] = useState<Record<string, { price: string; extra: string; active: boolean }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    api<{ products: Product[] }>("/api/admin/products").then((d) => {
      setProducts(d.products);
      setEdits(Object.fromEntries(d.products.map((p) => [p.id, { price: String(p.pricePaise / 100), extra: String(p.extraPaise / 100), active: p.active }])));
    });
  }, []);

  async function save(p: Product) {
    const e = edits[p.id];
    setErr(null);
    try {
      await api(`/api/products/${p.id}`, { method: "PUT", body: { pricePaise: Math.round(Number(e.price) * 100), extraPaise: Math.round(Number(e.extra) * 100), active: e.active } });
      setSaved(p.id);
      setTimeout(() => setSaved(null), 2000);
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  if (!products) return <Spinner />;
  return (
    <div className="space-y-3">
      {!owner && <div className="text-sm text-muted">Only the owner can change prices.</div>}
      <ErrorNote error={err} />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Shape</th>
              <th className="px-3 py-2">Price (₹, incl. GST)</th>
              <th className="px-3 py-2">Extra guest (₹)</th>
              <th className="px-3 py-2">On sale</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const e = edits[p.id];
              return (
                <tr key={p.id}>
                  <td className="px-3 py-2">
                    {p.name}
                    <div className="text-xs text-muted">
                      {p.pricing === "pack4" ? "per pack of 4" : "per person"} · party {p.minParty}–{p.maxParty}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{p.shape}</td>
                  <td className="px-3 py-2">
                    <input className="input w-28" disabled={!owner} value={e.price} onChange={(x) => setEdits({ ...edits, [p.id]: { ...e, price: x.target.value } })} />
                  </td>
                  <td className="px-3 py-2">
                    {p.pricing === "pack4" ? <input className="input w-24" disabled={!owner} value={e.extra} onChange={(x) => setEdits({ ...edits, [p.id]: { ...e, extra: x.target.value } })} /> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" disabled={!owner} checked={e.active} onChange={(x) => setEdits({ ...edits, [p.id]: { ...e, active: x.target.checked } })} />
                  </td>
                  <td className="px-3 py-2">
                    {owner && (
                      <button className="btn btn-sm" onClick={() => save(p)}>
                        {saved === p.id ? "Saved ✓" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Saving here changes the price now. To change it from a later date, schedule it below. Existing bookings always keep what they paid; every change is in the audit feed.</p>
      <ScheduledPrices products={products} owner={owner} />
    </div>
  );
}

interface Scheduled { id: number; product_id: string; effective_from: string; price_paise: number; extra_paise: number; created_by: string }

/** §7 price editor with effective-from dates: bookings for that day onward are quoted at the new price. */
function ScheduledPrices({ products, owner }: { products: Product[]; owner: boolean }) {
  const [rows, setRows] = useState<Scheduled[] | null>(null);
  const [form, setForm] = useState({ product: products[0]?.id ?? "", from: addDays(todayIST(), 7), price: "", extra: "" });
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    api<{ scheduled: Scheduled[] }>("/api/price-schedule").then((d) => setRows(d.scheduled));
  }, [v]);
  const p = products.find((x) => x.id === form.product);

  async function add() {
    setErr(null);
    try {
      await api("/api/price-schedule", {
        body: { productId: form.product, effectiveFrom: form.from, pricePaise: Math.round(Number(form.price) * 100), ...(form.extra ? { extraPaise: Math.round(Number(form.extra) * 100) } : {}) },
      });
      setForm({ ...form, price: "", extra: "" });
      setV((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function remove(id: number) {
    await api(`/api/price-schedule?id=${id}`, { method: "DELETE" });
    setV((x) => x + 1);
  }

  return (
    <div className="card space-y-3">
      <div className="font-semibold">Scheduled price changes</div>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">None scheduled.</div>
      ) : (
        <table className="data-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5">{products.find((x) => x.id === r.product_id)?.name ?? r.product_id}</td>
                <td>from {fmtDay(r.effective_from)}</td>
                <td className="font-medium tabular-nums">
                  {rupees(r.price_paise)}
                  {r.extra_paise ? ` (+${rupees(r.extra_paise)}/extra)` : ""}
                </td>
                <td className="text-xs text-muted">{r.created_by}</td>
                <td className="text-right">
                  {owner && (
                    <button className="btn btn-sm btn-danger" onClick={() => remove(r.id)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {owner && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Product">
            <select className="input" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
              {products.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} (now {rupees(x.pricePaise)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective from">
            <input type="date" className="input" min={todayIST()} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          </Field>
          <Field label="New price ₹">
            <input className="input w-28" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          {p?.pricing === "pack4" && (
            <Field label="Extra guest ₹">
              <input className="input w-24" value={form.extra} onChange={(e) => setForm({ ...form, extra: e.target.value })} />
            </Field>
          )}
          <button className="btn btn-primary" disabled={!form.price} onClick={add}>
            Schedule
          </button>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}

export function Memberships() {
  const [rows, setRows] = useState<{ id: number; name: string; phone: string; plan: string; valid_till: string; visits_left: number | null; used: number }[] | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", plan: "Annual Games", months: 12 as 6 | 12, visits: "24" });
  const [err, setErr] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);
  useEffect(() => {
    api<{ memberships: NonNullable<typeof rows> }>("/api/memberships").then((d) => setRows(d.memberships));
  }, [version]);
  async function create() {
    setErr(null);
    try {
      await api("/api/memberships", { body: { ...form, visits: form.visits === "" ? null : Number(form.visits) } });
      setForm({ ...form, name: "", phone: "" });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-2">
        <input className="input w-40" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input w-40" placeholder="Mobile" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input className="input w-44" placeholder="Plan" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
        <select className="input w-auto" value={form.months} onChange={(e) => setForm({ ...form, months: Number(e.target.value) as 6 | 12 })}>
          <option value={6}>6 months</option>
          <option value={12}>12 months</option>
        </select>
        <input className="input w-32" placeholder="Visits (blank = unlimited)" value={form.visits} onChange={(e) => setForm({ ...form, visits: e.target.value })} />
        <button className="btn btn-primary" disabled={!form.name || form.phone.length < 10} onClick={create}>
          Add member
        </button>
        <div className="w-full">
          <ErrorNote error={err} />
        </div>
      </div>
      {!rows ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="px-3 py-2">Member</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Valid till</th>
                <th className="px-3 py-2">Visits left</th>
                <th className="px-3 py-2">Used</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    {r.name} <span className="text-xs text-muted">{r.phone}</span>
                  </td>
                  <td className="px-3 py-2">{r.plan}</td>
                  <td className="px-3 py-2">{r.valid_till}</td>
                  <td className={`px-3 py-2 ${r.visits_left != null && r.visits_left <= 2 ? "text-amber" : ""}`}>{r.visits_left ?? "∞"}</td>
                  <td className="px-3 py-2">{r.used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AuditFeed() {
  const [rows, setRows] = useState<{ id: number; actor: string; action: string; entity: string; detail: Record<string, unknown>; at: number }[] | null>(null);
  useEffect(() => {
    api<{ events: NonNullable<typeof rows> }>("/api/admin/audit").then((d) => setRows(d.events));
  }, []);
  if (!rows) return <Spinner />;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap gap-x-3 border-b border-line py-2 text-sm">
          <span className="w-36 font-mono text-xs text-muted">{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
          <span className="w-44 truncate text-muted">{r.actor}</span>
          <span className="font-semibold">{r.action.replaceAll("_", " ")}</span>
          <span className="font-mono">{r.entity}</span>
          <span className="truncate text-xs text-muted">{JSON.stringify(r.detail)}</span>
        </div>
      ))}
    </div>
  );
}

export function Outbox() {
  const [rows, setRows] = useState<{ id: number; to_phone: string; template: string; payload: Record<string, string>; status: string; created_at: number; error: string | null }[] | null>(null);
  useEffect(() => {
    api<{ messages: NonNullable<typeof rows> }>("/api/admin/messages").then((d) => setRows(d.messages));
  }, []);
  if (!rows) return <Spinner />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">WhatsApp messages. Status “mock” = no WhatsApp credentials configured; the message was logged instead of sent.</p>
      {rows.map((r) => (
        <div key={r.id} className="card p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>
              <b>{r.template}</b> → {r.to_phone}
            </span>
            <span className="text-xs text-muted">
              {r.status} · {new Date(r.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
            </span>
          </div>
          <div className="mt-1 break-all text-xs text-muted">{Object.entries(r.payload).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>
          {r.error && <div className="text-xs text-red">{r.error}</div>}
        </div>
      ))}
      {rows.length === 0 && <div className="text-muted">No messages yet.</div>}
    </div>
  );
}
