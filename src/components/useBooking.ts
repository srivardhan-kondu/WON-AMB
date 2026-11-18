"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

export interface BookingView {
  code: string;
  token: string;
  status: string;
  product: { id: string; name: string; shape: string };
  day: string;
  start: number;
  end: number;
  party: number;
  legs: { room: string; roomId: string; start: number; end: number }[];
  pricePaise: number;
  paidPaise: number;
  depositPaise: number;
  holdExpires: number | null;
  invoice: string | null;
  waivers: { name: string; ageBand: string }[];
  customerName: string;
  phoneMasked: string;
  canReschedule: boolean;
  rescheduleCount: number;
  food: boolean;
  qr: string | null;
  guests: { name: string; ageBand?: string }[];
  canEditGuests: boolean;
  refundedPaise: number;
}

/** Loads a booking with the ?t= token from the URL, or a phone the user types. */
export function useBooking(code: string) {
  const [auth, setAuth] = useState<{ t?: string; phone?: string } | null>(null);
  const [booking, setBooking] = useState<BookingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needPhone, setNeedPhone] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) setAuth({ t });
    else setNeedPhone(true);
  }, []);

  const load = useCallback(async () => {
    if (!auth) return;
    const qs = auth.t ? `t=${encodeURIComponent(auth.t)}` : `phone=${encodeURIComponent(auth.phone ?? "")}`;
    try {
      const b = await api<BookingView>(`/api/bookings/${code}?${qs}`);
      setBooking(b);
      setError(null);
      setNeedPhone(false);
      if (!auth.t) {
        setAuth({ t: b.token });
        window.history.replaceState(null, "", `${window.location.pathname}?t=${b.token}`);
      }
    } catch (e) {
      setError((e as Error).message);
      if (!auth.t) setNeedPhone(true);
    }
  }, [auth, code]);

  useEffect(() => {
    load();
  }, [load]);

  return { booking, error, needPhone, reload: load, submitPhone: (phone: string) => setAuth({ phone }), token: auth?.t ?? booking?.token ?? null };
}
