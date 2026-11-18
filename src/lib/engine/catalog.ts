// Seed catalogue — WON (World of Neon) catalogue, AMB Mall Level 6. Prices in paise, GST-inclusive.

import type { DayConfig, Product, Room } from "./types";

export const DEFAULT_ROOMS: Room[] = [
  { id: "arena", name: "Arena", zone: "game", capacity: 6, resetMin: 5 },
  { id: "climb", name: "Climb", zone: "game", capacity: 6, resetMin: 5 },
  { id: "push", name: "Push", zone: "game", capacity: 6, resetMin: 5 },
  { id: "lazer", name: "Lazer Maze", zone: "game", capacity: 6, resetMin: 5 },
  { id: "grid", name: "Mega Grid", zone: "game", capacity: 6, resetMin: 5 },
  { id: "neon", name: "Neon Room", zone: "splatter", capacity: 12, resetMin: 15 },
  { id: "dayroom", name: "Day Room", zone: "splatter", capacity: 12, resetMin: 15 },
];

const base = { extraPaise: 0, pricing: "pp" as const, minParty: 1, maxParty: 6, durationMin: 0, active: true };

export const DEFAULT_PRODUCTS: Product[] = [
  { ...base, id: "c1", name: "Choice of 1 game", description: "Any one game room · 20 min (15 play + 5 reset)", shape: "grid20", legs: 1, legMin: 20, playMin: 15, pricePaise: 39900, zone: "game" },
  { ...base, id: "c3", name: "Choice of 3 games", description: "Three different rooms back-to-back · 1 hr", shape: "grid20", legs: 3, legMin: 20, playMin: 15, pricePaise: 99900, zone: "game" },
  { ...base, id: "a5", name: "All 5 games", description: "Every game room in a Rotation Hour · 5 × 12 min", shape: "rotation", legs: 5, legMin: 12, playMin: 10, pricePaise: 139900, zone: "game" },
  { ...base, id: "splat", name: "Neon Splatter Zone", description: "Neon Room + Day Room, 1 item & kit · 1 hr", shape: "splatter", legs: 1, legMin: 60, playMin: 60, pricePaise: 149900, zone: "splatter", maxParty: 12 },
  { ...base, id: "combo", name: "Games + Splatter combo", description: "Choice of 3 games, then a splatter session", shape: "combo", legs: 3, legMin: 20, playMin: 15, pricePaise: 249900, zone: "game" },
  { ...base, id: "family", name: "Family / Group pack (games)", description: "Choice of 3 for 4 people, +₹999 per extra guest", shape: "grid20", legs: 3, legMin: 20, playMin: 15, pricePaise: 399900, extraPaise: 99900, pricing: "pack4", minParty: 4, zone: "game" },
  { ...base, id: "party_games", name: "Birthday / Corporate — Game Zone", description: "Exclusive Game Zone · 1 hr · min 10 guests", shape: "party", legs: 5, legMin: 60, playMin: 60, pricePaise: 129900, zone: "game", minParty: 10, maxParty: 30, durationMin: 60 },
  { ...base, id: "party_neon", name: "Birthday / Corporate — Neon Zone", description: "Exclusive Splatter Zone · 1 hr · min 10 guests", shape: "party", legs: 2, legMin: 60, playMin: 60, pricePaise: 249900, zone: "splatter", minParty: 10, maxParty: 24, durationMin: 60 },
];

/** Default peak calendar (§8.1): Fri 17–22, Sat–Sun all day. */
export function defaultPeakHours(day: string, openMin: number, closeMin: number): number[] {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sun
  const hours: number[] = [];
  for (let h = Math.floor(openMin / 60); h * 60 < closeMin; h++) {
    if (dow === 0 || dow === 6) hours.push(h);
    else if (dow === 5 && h >= 17) hours.push(h);
  }
  return hours;
}

export function defaultDayConfig(day: string): DayConfig {
  const openMin = 11 * 60;
  const closeMin = 22 * 60;
  return {
    day,
    openMin,
    closeMin,
    peakHours: defaultPeakHours(day, openMin, closeMin),
    rotationHours: [],
    holdbackPct: 20,
    deepCleanStart: 16 * 60 + 30,
    deepCleanMin: 30,
    deepCleanZone: "game",
    splatterCadence: 75,
    all5Mode: "rotation",
  };
}
