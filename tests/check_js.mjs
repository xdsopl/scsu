// cross-check the JavaScript port against the WebAssembly build: same bytes out, same refusals
import { readFileSync } from "fs";
import * as js from "../module/scsu.js";

const wasm = (await WebAssembly.instantiate(readFileSync(process.argv[2]))).instance.exports;
const memory = wasm.memory.buffer;
const text = new Uint8Array(memory, wasm.text.value, 1 << 22);
const scsu = new Uint8Array(memory, wasm.scsu.value, 1 << 22);

function wasmEncodeUTF8(utf8) {
	text.set(utf8);
	const len = wasm.scsu_encode(utf8.length);
	return len < 0 ? null : scsu.slice(0, len);
}

function wasmDecodeUTF8(bytes) {
	scsu.set(bytes);
	const len = wasm.scsu_decode(bytes.length);
	return len < 0 ? null : text.slice(0, len);
}

function same(a, b) {
	if (a === null || b === null)
		return a === b;
	if (a.length !== b.length)
		return false;
	for (let i = 0; i < a.length; ++i)
		if (a[i] !== b[i])
			return false;
	return true;
}

function fail(what, input) {
	throw new Error(what + ": " + JSON.stringify(Array.from(input)));
}

const utf8 = s => new TextEncoder().encode(s);

const samples = [
	"Hungry. Anyone around 40m tonight? 73 de DL1ABC",
	"Grüße aus Köln, wir hören uns auf 80 m. Schöne Größe!",
	"Ça va être génial, à bientôt près de la côte.",
	"Привет всем! Кто сегодня на 40 метрах? Хочу есть.",
	"Γεια σας από την Αθήνα, πεινάω πολύ σήμερα.",
	"مرحبا بالجميع، أنا جائع جدا اليوم.",
	"שלום לכולם, אני רעב מאוד היום.",
	"नमस्ते सबको, आज मुझे बहुत भूख लगी है।",
	"সবাইকে নমস্কার, আজ আমার খুব খিদে পেয়েছে।",
	"அனைவருக்கும் வணக்கம், இன்று எனக்கு மிகவும் பசிக்கிறது.",
	"สวัสดีทุกคน วันนี้ฉันหิวมาก",
	"皆さんこんにちは、今日はとてもお腹が空いています。",
	"大家好，我今天非常饿。今晚有人在四十米波段吗？",
	"안녕하세요 여러분, 오늘 정말 배고파요.",
	"Hungry 🍕🍔 now 😋 73!",
	"QSL via büro. 東京 → Москва ✈ नमस्ते 𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
	"",
	"\uFEFF",
	"\uFEFFHungry",
	"Hungry\uFEFF",
	"73 \uFEFFПривет",
];

function check(s) {
	const u = utf8(s);
	const w = wasmEncodeUTF8(u);
	const a = js.encode(s);
	const b = js.encodeUTF8(u);
	if (!same(w, a) || !same(w, b))
		fail("encoder differs", u);
	if (js.decode(w) !== s || !same(js.decodeUTF8(w), u))
		fail("round trip", u);
}

for (const s of samples)
	check(s);

// random strings drawn from mixed blocks, as in check_icu.py
const blocks = [[0x20, 0x7F], [0x00, 0x20], [0x80, 0x250], [0x370, 0x400], [0x400, 0x530],
	[0x590, 0x700], [0x900, 0xE00], [0x2000, 0x2200], [0x3000, 0x3100],
	[0x4E00, 0x9FFF], [0xAC00, 0xD7A3], [0xE000, 0xF900], [0xFE00, 0x10000],
	[0x10000, 0x10400], [0x1F300, 0x1FAFF], [0x20000, 0x2A6DF], [0xF0000, 0x10FFFF]];
let seed = 1;
const rand = n => {
	seed = (seed * 1103515245 + 12345) >>> 0;
	return Math.floor((seed / 4294967296) * n);
};
for (let t = 0; t < 100000; ++t) {
	let s = "";
	for (let r = 1 + rand(5); r; --r) {
		const [lo, hi] = blocks[rand(blocks.length)];
		for (let k = 1 + rand(29); k; --k) {
			const c = lo + rand(hi - lo);
			if (c < 0xD800 || c >= 0xE000)
				s += String.fromCodePoint(c);
		}
	}
	check(s);
}
// long strings of many short runs, so the encoder keeps replacing windows
for (let t = 0; t < 3000; ++t) {
	let s = "";
	for (let r = 20 + rand(60); r; --r) {
		const [lo, hi] = blocks[rand(blocks.length)];
		const base = lo + rand(hi - lo);
		for (let k = 1 + rand(6); k; --k) {
			const c = Math.min(base + rand(0x100), 0x10FFFF);
			if (c < 0xD800 || c >= 0xE000)
				s += String.fromCodePoint(c);
		}
	}
	check(s);
}
console.log("encoder: 103000 random strings byte-identical");

// lone surrogates in a JS string are refused like invalid UTF-8
for (const s of ["\uD800", "a\uDC00", "\uD800a", "\uDBFF\uDBFF"])
	if (js.encode(s) !== null)
		throw new Error("lone surrogate accepted");

// invalid UTF-8 is refused by both
for (const b of [[0xC0, 0x80], [0xED, 0xA0, 0x80], [0xF4, 0x90, 0x80, 0x80], [0xE2, 0x82], [0x80], [0xFF]]) {
	const u = new Uint8Array(b);
	if (wasmEncodeUTF8(u) !== null || js.encodeUTF8(u) !== null)
		fail("invalid UTF-8 accepted", u);
}

// decoder: random bytes and mutated valid streams must give the same answer
let accepted = 0;
function checkDecode(b) {
	const w = wasmDecodeUTF8(b);
	const j = js.decodeUTF8(b);
	if (!same(w, j))
		fail("decoder differs", b);
	const s = js.decode(b);
	if ((s === null) !== (w === null) || (s !== null && !same(utf8(s), w)))
		fail("decode string differs", b);
	if (w !== null)
		++accepted;
}
for (const b of [[0x0c], [0x0e, 0xd8, 0x00], [0x0f, 0xdc, 0x00], [0x01], [0x18, 0x00], [0x18, 0xb0], [0x0f, 0xf2], [0x0f, 0xe8, 0x00]])
	if (js.decode(new Uint8Array(b)) !== null)
		throw new Error("malformed accepted: " + b);
// edges of the decoder's fast paths: the highest SDX window up to U+10FFFF,
// runs mixing direct bytes, runs after an unpaired high surrogate, ASCII prefixes
for (const b of [
	[0x0B, 0xFF, 0xFF, 0xFF, 0xFE, 0x20, 0x80], [0x0B, 0x00, 0x00, 0x80, 0x41, 0xFF, 0x0A],
	[0x0E, 0xD8, 0x00, 0x80], [0x0E, 0xD8, 0x00, 0x41], [0x0E, 0xD8, 0x00, 0x0E, 0xDC, 0x00, 0x80],
	[0x0F, 0xD8, 0x00, 0xE0, 0x80], [0x0F, 0xD8, 0x00, 0xDC, 0x00, 0xE0, 0x41],
	[0x41, 0x42, 0x0C], [0x41, 0x42, 0x01], [0x41, 0x0A, 0x0D, 0x09, 0x00, 0x80], [0x41, 0x18, 0xF9, 0x80],
])
	checkDecode(new Uint8Array(b));
const pool = samples.map(s => wasmEncodeUTF8(utf8(s)));
for (let t = 0; t < 200000; ++t) {
	let b;
	if (t & 1) {
		b = new Uint8Array(1 + rand(40));
		for (let i = 0; i < b.length; ++i)
			b[i] = rand(256);
	} else {
		b = pool[rand(pool.length)].slice();
		for (let m = 1 + rand(3); m && b.length; --m)
			b[rand(b.length)] = rand(256);
	}
	checkDecode(b);
}
console.log(`decoder: 200000 random/mutated inputs agree (${accepted} accepted)`);
console.log("js: ok");
