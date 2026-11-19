"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/client";
import { AGE_BANDS, type AgeBand } from "@/lib/waiver";
import { ErrorNote, Spinner } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmtMin, todayIST } from "@/lib/time";

interface BarcodeDetectorLike {
  detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
  }
}

/** Scan QR or type the WON-code → waiver status → arrive. Unsigned guests sign right here on the desk tablet. */
export function CheckIn({ initial, onDone }: { initial?: string; onDone?: () => void }) {
  const [scan, setScan] = useState(initial ?? "");
  const [result, setResult] = useState<{ code: string; party: number } | null>(null);
  const [missing, setMissing] = useState<{ code: string; signed: number; party: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [guests, setGuests] = useState<{ name: string; ageBand: AgeBand }[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (initial) {
      setScan(initial);
      submit(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  async function submit(value = scan, shrinkTo?: number) {
    setErr(null);
    setResult(null);
    try {
      const r = await api<{ code: string; party: number }>("/api/checkin", { body: { scan: value, shrinkTo } });
      setResult(r);
      setMissing(null);
      setScan("");
      onDone?.();
    } catch (e) {
      if (e instanceof ApiError && e.data.needWaivers) {
        const code = value.match(/WON-[A-Z0-9]{4}/i)?.[0].toUpperCase() ?? value;
        const m = { code, signed: Number(e.data.signed), party: Number(e.data.party) };
        setMissing(m);
        setGuests(Array.from({ length: m.party - m.signed }, () => ({ name: "", ageBand: "18+" as AgeBand })));
      } else setErr((e as Error).message);
    }
  }

  async function signOnDesk() {
    if (!missing) return;
    const filled = guests.filter((g) => g.name.trim().length >= 2);
    if (!filled.length) return;
    try {
      await api(`/api/waivers/${missing.code}`, { body: { guests: filled.map((g) => ({ ...g, accept: true })) } });
      await submit(missing.code);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      if (!window.BarcodeDetector) {
        setErr("This browser can't scan QR codes — type the WON-code instead.");
        setCamera(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const det = new window.BarcodeDetector({ formats: ["qr_code"] });
        while (!stop) {
          const codes = await det.detect(videoRef.current).catch(() => []);
          if (codes[0]?.rawValue) {
            setCamera(false);
            setScan(codes[0].rawValue);
            submit(codes[0].rawValue);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setErr("Camera unavailable");
        setCamera(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <section className="card space-y-4">
          <div>
            <div className="card-title">Scan or type a booking code</div>
            <p className="text-xs text-muted">Point the camera at the guest&apos;s WhatsApp QR, or type the code printed under it.</p>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Icon name="qr" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
              <input
                className="input py-3 pl-10 font-mono text-lg uppercase tracking-wider"
                placeholder="WON-XXXX"
                autoFocus
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>
            <button className="btn btn-cyan whitespace-nowrap px-5" disabled={scan.length < 4} onClick={() => submit()}>
              Check in
            </button>
            <button className="btn whitespace-nowrap" onClick={() => setCamera((c) => !c)}>
              {camera ? "Stop camera" : "Camera"}
            </button>
          </div>
          {camera && <video ref={videoRef} className="w-full rounded-lg border border-line" muted playsInline />}
          <ErrorNote error={err} />
        </section>

        {result && (
          <section className="card flex items-center gap-4 border-lime/30 bg-lime/5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-lime/15 text-lime">
              <Icon name="check" className="h-7 w-7" />
            </div>
            <div>
              <div className="font-semibold text-lime">Checked in · {result.party} guest{result.party === 1 ? "" : "s"}</div>
              <div className="font-mono text-sm text-muted">{result.code}</div>
            </div>
          </section>
        )}

        {missing && (
          <section className="card space-y-3 border-amber/30">
            <div className="flex items-center justify-between">
              <div className="card-title">
                {missing.code} · waivers {missing.signed}/{missing.party}
              </div>
              <span className="chip border-amber/20 bg-amber/10 text-amber">{missing.party - missing.signed} to sign</span>
            </div>
            <p className="text-sm text-muted">Have the remaining guests sign on this tablet (they confirm they&apos;ve read the waiver), or check in only the signed guests — their unused seats go back on sale.</p>
            {guests.map((g, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2">
                <input className="input" placeholder={`Guest ${missing.signed + i + 1} full name`} value={g.name} onChange={(e) => setGuests(guests.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                <select className="input w-auto" value={g.ageBand} onChange={(e) => setGuests(guests.map((x, k) => (k === i ? { ...x, ageBand: e.target.value as AgeBand } : x)))}>
                  {AGE_BANDS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-cyan" onClick={signOnDesk}>
                Guests accept waiver & check in
              </button>
              {missing.signed > 0 && (
                <button className="btn" onClick={() => submit(missing.code, missing.signed)}>
                  Check in {missing.signed} signed only
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <ArrivingNext refreshKey={result?.code ?? ""} onPick={(code) => { setScan(code); submit(code); }} />
    </div>
  );
}

interface Arrival { code: string; name: string | null; start_min: number; party_size: number; waivers: number; status: string; product: string }

/** Today's guests still to arrive, soonest first — tap to check in without typing the code. */
function ArrivingNext({ onPick, refreshKey }: { onPick: (code: string) => void; refreshKey: string }) {
  const [rows, setRows] = useState<Arrival[] | null>(null);
  useEffect(() => {
    const load = () =>
      api<{ bookings: Arrival[] }>(`/api/desk/today?date=${todayIST()}`)
        .then((d) => setRows(d.bookings.filter((b) => b.status === "confirmed").sort((a, b) => a.start_min - b.start_min)))
        .catch(() => setRows([]));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [refreshKey]);
  return (
    <aside className="card self-start p-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="card-title">Arriving next</div>
        <span className="text-xs text-muted">{rows?.length ?? 0} to check in</span>
      </div>
      <div className="max-h-[480px] divide-y divide-line overflow-y-auto">
        {rows == null && <div className="p-6 text-center text-muted"><Spinner /></div>}
        {rows?.length === 0 && <div className="p-6 text-center text-sm text-muted">Everyone booked for today is checked in.</div>}
        {rows?.map((r) => (
          <button key={r.code} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-panel-2" onClick={() => onPick(r.code)}>
            <div className="w-16 shrink-0 text-sm font-semibold">{fmtMin(r.start_min)}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.name || "Guest"} · {r.party_size}</div>
              <div className="truncate text-xs text-muted">
                <span className="font-mono">{r.code}</span> · {r.product}
              </div>
            </div>
            <span className={`text-xs font-medium ${r.waivers >= r.party_size ? "text-lime" : "text-amber"}`}>{Math.min(r.waivers, r.party_size)}/{r.party_size}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
