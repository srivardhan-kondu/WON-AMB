"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/client";
import { AGE_BANDS, type AgeBand } from "@/lib/waiver";
import { ErrorNote } from "@/components/ui";

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
    <div className="max-w-xl space-y-4">
      <div className="flex gap-2">
        <input
          className="input font-mono text-lg uppercase"
          placeholder="Scan QR or type WON-XXXX"
          autoFocus
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn btn-cyan" disabled={scan.length < 4} onClick={() => submit()}>
          Check in
        </button>
        <button className="btn" onClick={() => setCamera((c) => !c)}>
          {camera ? "Stop" : "Camera"}
        </button>
      </div>
      {camera && <video ref={videoRef} className="w-full rounded-xl border border-line" muted playsInline />}
      <ErrorNote error={err} />
      {result && (
        <div className="card border-lime/50 text-center">
          <div className="text-3xl">✓</div>
          <div className="font-mono text-xl">{result.code}</div>
          <div className="text-lime">Checked in · {result.party} guests</div>
        </div>
      )}
      {missing && (
        <div className="card space-y-3 border-amber/50">
          <div className="font-semibold text-amber">
            {missing.code}: {missing.signed} of {missing.party} waivers signed
          </div>
          <p className="text-sm text-muted">Have the remaining guests sign on this tablet (they confirm they&apos;ve read the waiver), or check in only the signed guests — their unused seats go back on sale.</p>
          {guests.map((g, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2">
              <input className="input" placeholder={`Guest ${missing.signed + i + 1} name`} value={g.name} onChange={(e) => setGuests(guests.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
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
        </div>
      )}
    </div>
  );
}
