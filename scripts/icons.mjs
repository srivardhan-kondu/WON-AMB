// Renders public/icons/icon.svg to the PNG sizes the PWA manifest and iOS need. Run: npm run icons
import sharp from "sharp";
import fs from "node:fs";
const svg = fs.readFileSync(new URL("../public/icons/icon.svg", import.meta.url));
const out = (n) => new URL(`../public/icons/${n}`, import.meta.url).pathname;
for (const size of [192, 512]) await sharp(svg, { density: 300 }).resize(size, size).png().toFile(out(`icon-${size}.png`));
// Maskable: full-bleed background with the mark inside the 80% safe zone.
const inner = await sharp(svg, { density: 300 }).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#07060d" } }).composite([{ input: inner, gravity: "center" }]).png().toFile(out("maskable-512.png"));
await sharp(svg, { density: 300 }).resize(180, 180).flatten({ background: "#07060d" }).png().toFile(new URL("../src/app/apple-icon.png", import.meta.url).pathname);
console.log("icons written");
