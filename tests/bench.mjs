// compare the JavaScript port with the WebAssembly module: throughput and start-up
// usage: node tests/bench.mjs docs/scsu.wasm
import { readFileSync } from "fs";
import { performance } from "perf_hooks";

const t0 = performance.now();
const js = await import("../module/scsu.js");
const t1 = performance.now();
const bytes = readFileSync(process.argv[2]);
const t2 = performance.now();
const wasm = (await WebAssembly.instantiate(bytes)).instance.exports;
const t3 = performance.now();
console.log(`start-up: JS import ${(t1 - t0).toFixed(2)} ms, WASM instantiate ${(t3 - t2).toFixed(2)} ms\n`);

const memory = wasm.memory.buffer;
const text = new Uint8Array(memory, wasm.text.value, 1 << 22);
const scsu = new Uint8Array(memory, wasm.scsu.value, 1 << 22);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// what an application does with the module: string in, bytes out and back
const W = {
	encode(str) {
		const r = encoder.encodeInto(str, text);
		const len = wasm.scsu_encode(r.written);
		return len < 0 ? null : scsu.slice(0, len);
	},
	decode(b) {
		scsu.set(b);
		const len = wasm.scsu_decode(b.length);
		return len < 0 ? null : decoder.decode(text.subarray(0, len));
	},
	encodeUTF8(u) {
		text.set(u);
		const len = wasm.scsu_encode(u.length);
		return len < 0 ? null : scsu.slice(0, len);
	},
	decodeUTF8(b) {
		scsu.set(b);
		const len = wasm.scsu_decode(b.length);
		return len < 0 ? null : text.slice(0, len);
	},
};

const sentences = {
	English: "Hungry. Anyone around 40m tonight? 73 de DL1ABC ",
	Russian: "Привет всем! Кто сегодня на 40 метрах? Хочу есть. ",
	Hindi: "नमस्ते सबको, आज मुझे बहुत भूख लगी है। ",
	Chinese: "大家好，我今天非常饿。今晚有人在四十米波段吗？",
	Mixed: "QSL via büro. 東京 → Москва ✈ नमस्ते 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🍕 ",
};

function repeatTo(s, utf8Bytes) {
	let r = s;
	while (encoder.encode(r + s).length <= utf8Bytes)
		r += s;
	return r;
}

// runs fn until ~150 ms have passed, after a warm-up; returns ns per call
function time(fn, arg) {
	for (let i = 0; i < 50; ++i)
		fn(arg);
	let n = 1, elapsed;
	for (;;) {
		const start = performance.now();
		for (let i = 0; i < n; ++i)
			fn(arg);
		elapsed = performance.now() - start;
		if (elapsed > 150)
			break;
		n *= 2;
	}
	return elapsed * 1e6 / n;
}

function fmt(ns) {
	return ns < 1e3 ? ns.toFixed(0) + " ns" : ns < 1e6 ? (ns / 1e3).toFixed(1) + " µs" : (ns / 1e6).toFixed(2) + " ms";
}

const sizes = [["short", 0], ["4 KiB", 4096], ["1 MiB", 1 << 20]];
const rows = [];
for (const [sizeName, size] of sizes) {
	for (const [script, s] of Object.entries(sentences)) {
		const str = size ? repeatTo(s, size) : s;
		const u = encoder.encode(str);
		const b = W.encode(str);
		const row = { size: sizeName, script, utf8: u.length, scsu: b.length };
		for (const [op, arg] of [["encode", str], ["decode", b], ["encodeUTF8", u], ["decodeUTF8", b]]) {
			const tw = time(W[op], arg);
			const tj = time(js[op], arg);
			row[op] = `${fmt(tw)} / ${fmt(tj)} (${(tj / tw).toFixed(2)}x)`;
		}
		rows.push(row);
	}
}
console.log("times are WASM / JS (JS relative to WASM, below 1 means JS is faster)");
console.log("encode/decode: string API; encodeUTF8/decodeUTF8: raw UTF-8 bytes");
console.table(rows);
