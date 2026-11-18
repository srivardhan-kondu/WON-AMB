// Runsheet: the staff-facing view of the ledger. Generated, never hand-edited.

import { db } from "./db";
import { builtInBlocks, splatterStarts } from "./engine";
import { buildLedger, getDayConfig, listProducts, listRooms } from "./repo";
import { nowIST } from "./time";

export interface RunsheetLeg {
  code: string;
  product: string;
  shape: string;
  party: number;
  status: string;
  name: string;
  start: number;
  end: number;
  food: boolean;
  waiversOk: boolean;
}

export function runsheet(day: string) {
  const d = db();
  const rooms = listRooms();
  const cfg = getDayConfig(day);
  const products = new Map(listProducts(true).map((p) => [p.id, p]));
  const t = Date.now();
  const rows = d
    .prepare(
      `SELECT l.room_id, l.start_min, l.end_min, b.code, b.product_id, b.party_size, b.status, b.food, b.hold_expires, b.id AS booking_id,
              COALESCE(c.name, '') AS name, (SELECT COUNT(*) FROM waivers w WHERE w.booking_id = b.id) AS waivers
       FROM booking_legs l JOIN bookings b ON b.id = l.booking_id LEFT JOIN customers c ON c.id = b.customer_id
       WHERE l.day = ? AND b.status IN ('hold','confirmed','arrived','done','no_show')
       ORDER BY l.start_min`,
    )
    .all(day) as {
    room_id: string; start_min: number; end_min: number; code: string; product_id: string; party_size: number; status: string;
    food: number; hold_expires: number | null; booking_id: number; name: string; waivers: number;
  }[];

  const byRoom = new Map<string, RunsheetLeg[]>(rooms.map((r) => [r.id, []]));
  for (const r of rows) {
    if (r.status === "hold" && (r.hold_expires ?? 0) < t) continue;
    byRoom.get(r.room_id)?.push({
      code: r.code,
      product: products.get(r.product_id)?.name ?? r.product_id,
      shape: products.get(r.product_id)?.shape ?? "",
      party: r.party_size,
      status: r.status,
      name: r.name.split(" ")[0] ?? "",
      start: r.start_min,
      end: r.end_min,
      food: !!r.food,
      waiversOk: r.waivers >= r.party_size,
    });
  }

  const blockRows = d.prepare("SELECT cb.room_id, cb.start_min, cb.end_min, cb.reason FROM calendar_blocks cb LEFT JOIN bookings b ON b.id = cb.booking_id WHERE cb.day = ? AND (cb.booking_id IS NULL OR b.status IN ('hold','confirmed','arrived','done'))").all(day) as {
    room_id: string; start_min: number; end_min: number; reason: string;
  }[];
  const blocks = [
    ...builtInBlocks(rooms, cfg),
    ...blockRows.map((b) => ({ roomId: b.room_id, start: b.start_min, end: b.end_min, reason: b.reason })),
  ];

  const ledger = buildLedger(day);
  const rotationHours = [...ledger.rotLegs].map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);

  const now = nowIST();
  return {
    day,
    serverNow: now.day === day ? now.min : null,
    openMin: cfg.openMin,
    closeMin: cfg.closeMin,
    rooms: rooms.map((r) => ({ ...r, legs: byRoom.get(r.id) ?? [], blocks: blocks.filter((b) => b.roomId === r.id) })),
    rotationHours,
    splatterSessions: splatterStarts(cfg),
  };
}
