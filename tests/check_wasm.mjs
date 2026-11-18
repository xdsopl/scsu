// smoke test of the WebAssembly build: round trips and sizes
import { readFileSync } from "fs";

const wasm = (await WebAssembly.instantiate(readFileSync(process.argv[2]))).instance.exports;
const memory = wasm.memory.buffer;
const text = new Uint8Array(memory, wasm.text.value, 1 << 22);
const scsu = new Uint8Array(memory, wasm.scsu.value, 1 << 22);

function encode(str) {
	const utf8 = new TextEncoder().encode(str);
	text.set(utf8);
	const len = wasm.scsu_encode(utf8.length);
	if (len < 0)
		throw new Error("encode failed");
	return scsu.slice(0, len);
}

function decode(bytes) {
	scsu.set(bytes);
	const len = wasm.scsu_decode(bytes.length);
	if (len < 0)
		return null;
	return new TextDecoder("utf-8", { fatal: true }).decode(text.slice(0, len));
}

const samples = ["Hungry", "Привет всем!", "नमस्ते सबको", "大家好", "Hungry 🍕 73!"];
for (const s of samples) {
	const b = encode(s);
	if (decode(b) !== s)
		throw new Error("round trip failed: " + s);
	console.log(s, new TextEncoder().encode(s).length, "->", b.length);
}
if (decode(new Uint8Array([0x0c])) !== null)
	throw new Error("reserved tag accepted");
console.log("wasm: ok");
