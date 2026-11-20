/** Lead-guest profile collected at the desk (who visits WON, for reporting). */
export const GENDERS = ["male", "female", "other"] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABEL: Record<Gender, string> = { male: "Male", female: "Female", other: "Other" };
export const AGE_MIN = 1;
export const AGE_MAX = 100;
