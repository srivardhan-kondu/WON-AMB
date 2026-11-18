export const AGE_BANDS = ["18+", "10–17", "Under 10 (with guardian)"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const WAIVER_TEXT = [
  "I understand that World of Neon activities (interactive games, LED floor, climbing wall, laser maze and paint splatter) involve physical activity and a risk of minor injury.",
  "I will follow staff instructions and safety briefings, wear provided protective gear, and not play under the influence of alcohol.",
  "Guests aged 10+ may play unaccompanied; under-10s must be supervised by a signing guardian at all times.",
  "Paint used in the Splatter Zone is non-toxic and washable, but may stain clothing. Ponchos are provided.",
  "I consent to WON keeping this record (name, age band, time and device IP) as required for venue safety.",
];
