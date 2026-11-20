// SCSU (UTS #6) in plain JavaScript: a port of module/scsu.c
// Copyright 2026 Ahmet Inan <xdsopl@gmail.com>
//
// Produces byte-identical output to the WebAssembly module and accepts and
// refuses exactly the same input. Unlike the module it has no 2^20 byte limit.
//
// encode(string)      -> Uint8Array, or null for lone surrogates
// decode(Uint8Array)  -> string, or null for malformed SCSU
// encodeUTF8(Uint8Array) -> Uint8Array, or null for invalid UTF-8
// decodeUTF8(Uint8Array) -> Uint8Array (UTF-8), or null for malformed SCSU

const STATIC_OFFSET = [0x0000, 0x0080, 0x0100, 0x0300, 0x2000, 0x2080, 0x2100, 0x3000];
const INITIAL_OFFSET = [0x0080, 0x00C0, 0x0400, 0x0600, 0x0900, 0x3040, 0x30A0, 0xFF00];
const SPECIAL_OFFSET = [0x00C0, 0x0250, 0x0370, 0x0530, 0x3040, 0x30A0, 0xFF60];

const SQ0 = 0x01, SDX = 0x0B, SQU = 0x0E, SCU = 0x0F, SC0 = 0x10, SD0 = 0x18;
const UC0 = 0xE0, UD0 = 0xE8, UQU = 0xF0, UDX = 0xF1;

// window offset for index x of SDn/UDn, or -1 if undefined
function windowOffset(x) {
	if (x < 1)
		return -1;
	if (x < 0x68)
		return x * 0x80;
	if (x < 0xA8)
		return x * 0x80 + 0xAC00;
	if (x < 0xF9)
		return -1;
	return SPECIAL_OFFSET[x - 0xF9];
}

// scratch buffers, grown on demand and reused between calls
let points = new Uint32Array(1024);
let out = new Uint8Array(4096);
let units = new Uint16Array(2048);

/* ---------------- decoder ---------------- */

// The decoder keeps its state in locals, like the encoder below. It writes
// UTF-16, which SCSU is built on, and checks it as it goes: no lone
// surrogates and nothing above U+10FFFF, as UTF-8 can't hold them.

const decDynamic = new Int32Array(8);
let utf8 = new Uint8Array(4096);

// write a code point that is not a surrogate, return the new length or -1
function putPoint(u, n, c) {
	if (c < 0x10000) {
		if (c >= 0xD800 && c < 0xE000)
			return -1;
		u[n++] = c;
		return n;
	}
	if (c > 0x10FFFF)
		return -1;
	c -= 0x10000;
	u[n++] = 0xD800 + (c >> 10);
	u[n++] = 0xDC00 + (c & 0x3FF);
	return n;
}

// decode s from start on, with the initial state, into the UTF-16 scratch
// buffer, return its length or -1
function decodeUnits(s, start) {
	const slen = s.length;
	if (units.length < 2 * slen)
		units = new Uint16Array(2 * slen);
	const u = units, dyn = decDynamic;
	for (let k = 0; k < 8; ++k)
		dyn[k] = INITIAL_OFFSET[k];
	let unicode = false, window = 0, i = start, n = 0;
	// a high surrogate from SQU or unicode mode waiting for its low half
	let high = 0;
	while (i < slen) {
		let b = s[i++];
		if (!unicode) {
			if (b >= 0x80 || direct(b)) {
				if (high)
					return -1;
				const off = dyn[window];
				if (off < 0x10000) {
					// a BMP window only holds valid characters: write the whole run
					for (;;) {
						u[n++] = b >= 0x80 ? off + b - 0x80 : b;
						if (i >= slen)
							break;
						b = s[i];
						if (b < 0x80 && !direct(b))
							break;
						++i;
					}
				} else {
					// so does one above it: SDX reaches no further than 0x10FF80
					const base = off - 0x10000 - 0x80;
					for (;;) {
						if (b >= 0x80) {
							const c = base + b;
							u[n++] = 0xD800 + (c >> 10);
							u[n++] = 0xDC00 + (c & 0x3FF);
						} else {
							u[n++] = b;
						}
						if (i >= slen)
							break;
						b = s[i];
						if (b < 0x80 && !direct(b))
							break;
						++i;
					}
				}
				continue;
			}
			let x;
			if (b >= SQ0 && b < SQ0 + 8) {
				if (i >= slen || high)
					return -1;
				const t = s[i++], w = b - SQ0;
				n = putPoint(u, n, t < 0x80 ? STATIC_OFFSET[w] + t : dyn[w] + t - 0x80);
				if (n < 0)
					return -1;
				continue;
			} else if (b === SDX) {
				if (i + 2 > slen)
					return -1;
				const h = s[i++], l = s[i++];
				window = h >> 5;
				dyn[window] = 0x10000 + (((h & 0x1F) << 8) | l) * 0x80;
				continue;
			} else if (b === SQU) {
				if (i + 2 > slen)
					return -1;
				x = s[i] << 8 | s[i + 1];
				i += 2;
			} else if (b === SCU) {
				unicode = true;
				continue;
			} else if (b >= SC0 && b < SC0 + 8) {
				window = b - SC0;
				continue;
			} else if (b >= SD0 && b < SD0 + 8) {
				if (i >= slen)
					return -1;
				window = b - SD0;
				const offset = windowOffset(s[i++]);
				if (offset < 0)
					return -1;
				dyn[window] = offset;
				continue;
			} else {
				return -1;
			}
			// one UTF-16 code unit from SQU, pairing surrogates
			if (high) {
				if (x < 0xDC00 || x >= 0xE000)
					return -1;
				u[n++] = high;
				u[n++] = x;
				high = 0;
			} else if (x >= 0xD800 && x < 0xE000) {
				if (x >= 0xDC00)
					return -1;
				high = x;
			} else {
				u[n++] = x;
			}
		} else {
			let x;
			if (b < UC0 || b > 0xF2) {
				if (i >= slen)
					return -1;
				x = b << 8 | s[i++];
			} else if (b < UD0) {
				window = b - UC0;
				unicode = false;
				continue;
			} else if (b < UQU) {
				if (i >= slen)
					return -1;
				window = b - UD0;
				const offset = windowOffset(s[i++]);
				if (offset < 0)
					return -1;
				dyn[window] = offset;
				unicode = false;
				continue;
			} else if (b === UQU) {
				if (i + 2 > slen)
					return -1;
				x = s[i] << 8 | s[i + 1];
				i += 2;
			} else if (b === UDX) {
				if (i + 2 > slen)
					return -1;
				const h = s[i++], l = s[i++];
				window = h >> 5;
				dyn[window] = 0x10000 + (((h & 0x1F) << 8) | l) * 0x80;
				unicode = false;
				continue;
			} else {
				// 0xF2 is reserved
				return -1;
			}
			// one UTF-16 code unit, pairing surrogates
			if (high) {
				if (x < 0xDC00 || x >= 0xE000)
					return -1;
				u[n++] = high;
				u[n++] = x;
				high = 0;
			} else if (x >= 0xD800 && x < 0xE000) {
				if (x >= 0xDC00)
					return -1;
				high = x;
			} else {
				u[n++] = x;
			}
		}
	}
	if (high)
		return -1;
	return n;
}

// length of the leading run of bytes that SCSU leaves as they are: ASCII
// text decodes to itself, with the initial state still in place after it
function directPrefix(s) {
	let p = 0;
	while (p < s.length && direct(s[p]))
		++p;
	return p;
}

// the scratch buffer is in platform byte order, which is little-endian everywhere JS runs
// ignoreBOM keeps a U+FEFF at the start of each piece, which is text here
const utf16Decoder = new TextDecoder("utf-16le", { ignoreBOM: true });
const asciiDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// TextDecoder beats String.fromCharCode even on a few characters
function unitsToString(len) {
	return utf16Decoder.decode(units.subarray(0, len));
}

export function decode(bytes) {
	const p = directPrefix(bytes);
	if (p === bytes.length)
		return asciiDecoder.decode(bytes);
	const len = decodeUnits(bytes, p);
	if (len < 0)
		return null;
	const tail = unitsToString(len);
	return p ? asciiDecoder.decode(bytes.subarray(0, p)) + tail : tail;
}

export function decodeUTF8(bytes) {
	const p = directPrefix(bytes);
	if (p === bytes.length)
		return bytes.slice();
	const len = decodeUnits(bytes, p);
	if (len < 0)
		return null;
	// a unit takes at most three bytes, a surrogate pair four
	if (utf8.length < p + 3 * len)
		utf8 = new Uint8Array(p + 3 * len);
	const o = utf8, u = units;
	o.set(bytes.subarray(0, p));
	let pos = p;
	for (let k = 0; k < len; ++k) {
		let c = u[k];
		if (c < 0x80) {
			o[pos++] = c;
		} else if (c < 0x800) {
			o[pos++] = 0xC0 | c >> 6;
			o[pos++] = 0x80 | (c & 0x3F);
		} else if (c < 0xD800 || c >= 0xDC00) {
			o[pos++] = 0xE0 | c >> 12;
			o[pos++] = 0x80 | (c >> 6 & 0x3F);
			o[pos++] = 0x80 | (c & 0x3F);
		} else {
			// decodeUnits only writes complete surrogate pairs
			c = 0x10000 + ((c - 0xD800) << 10) + (u[++k] - 0xDC00);
			o[pos++] = 0xF0 | c >> 18;
			o[pos++] = 0x80 | (c >> 12 & 0x3F);
			o[pos++] = 0x80 | (c >> 6 & 0x3F);
			o[pos++] = 0x80 | (c & 0x3F);
		}
	}
	return o.slice(0, pos);
}

/* ---------------- encoder ---------------- */

function stringToPoints(str) {
	const n = str.length;
	if (points.length < n)
		points = new Uint32Array(n);
	let count = 0;
	for (let i = 0; i < n; ++i) {
		let c = str.charCodeAt(i);
		if (c >= 0xD800 && c < 0xE000) {
			if (c >= 0xDC00 || i + 1 >= n)
				return -1;
			const l = str.charCodeAt(i + 1);
			if (l < 0xDC00 || l >= 0xE000)
				return -1;
			c = 0x10000 + ((c - 0xD800) << 10) + (l - 0xDC00);
			++i;
		}
		points[count++] = c;
	}
	return count;
}

function utf8ToPoints(text) {
	const tlen = text.length;
	if (points.length < tlen)
		points = new Uint32Array(tlen);
	let i = 0, count = 0;
	while (i < tlen) {
		const b = text[i++];
		if (b < 0x80) {
			points[count++] = b;
			continue;
		}
		let c, more, min;
		if (b >= 0xC2 && b < 0xE0) {
			c = b & 0x1F;
			more = 1;
			min = 0x80;
		} else if (b >= 0xE0 && b < 0xF0) {
			c = b & 0x0F;
			more = 2;
			min = 0x800;
		} else if (b >= 0xF0 && b < 0xF5) {
			c = b & 0x07;
			more = 3;
			min = 0x10000;
		} else {
			return -1;
		}
		if (i + more > tlen)
			return -1;
		for (let k = 0; k < more; ++k) {
			const t = text[i++];
			if ((t & 0xC0) !== 0x80)
				return -1;
			c = c << 6 | (t & 0x3F);
		}
		if (c < min || c > 0x10FFFF || (c >= 0xD800 && c < 0xE000))
			return -1;
		points[count++] = c;
	}
	return count;
}

// The encoder keeps its state in locals of encodePoints and passes it to
// small helpers as arguments: V8 inlines those, while module-level mutable
// state would be reloaded and checked on every access.

const encDynamic = new Int32Array(8);
const encStamp = new Float64Array(8);

function direct(c) {
	return (c >= 0x20 && c < 0x80) || c === 0x00 || c === 0x09 || c === 0x0A || c === 0x0D;
}

function findWindow(dynamic, active, c) {
	if (c >= dynamic[active] && c < dynamic[active] + 0x80)
		return active;
	for (let n = 0; n < 8; ++n)
		if (c >= dynamic[n] && c < dynamic[n] + 0x80)
			return n;
	return -1;
}

// window index x for SDn, or -1 if c can't be reached through a BMP window,
// with the special offsets taking precedence in the order of SPECIAL_OFFSET
function defineIndex(c) {
	if (c < 0x3400) {
		if (c < 0x05B0) {
			if (c >= 0x00C0 && c < 0x0140)
				return 0xF9;
			if (c >= 0x0250 && c < 0x02D0)
				return 0xFA;
			if (c >= 0x0370 && c < 0x03F0)
				return 0xFB;
			if (c >= 0x0530)
				return 0xFC;
		} else if (c >= 0x3040 && c < 0x3120) {
			return c < 0x30C0 ? 0xFD : 0xFE;
		}
		return c >= 0x80 ? c >> 7 : -1;
	}
	if (c < 0xE000 || c >= 0x10000)
		return -1;
	if (c >= 0xFF60 && c < 0xFFE0)
		return 0xFF;
	return (c - 0xAC00) >> 7;
}

// can c be defined as a window, by SDn/UDn or SDX/UDX
function definable(c) {
	return c >= 0x10000 || defineIndex(c) >= 0;
}

function sameWindow(a, b) {
	if (a >= 0x10000)
		return b >= 0x10000 && (a >> 7) === (b >> 7);
	const x = defineIndex(a);
	if (x < 0)
		return false;
	const offset = windowOffset(x);
	return offset >= 0 && b >= offset && b < offset + 0x80;
}

function oldest(stamp) {
	let best = 0;
	for (let n = 1; n < 8; ++n)
		if (stamp[n] < stamp[best])
			best = n;
	return best;
}

// write the tag that defines window n for c, SDn/SDX or UDn/UDX, return the new position
function defineWindow(o, pos, dynamic, n, c, unicode) {
	if (c >= 0x10000) {
		const index = (c - 0x10000) >> 7;
		o[pos++] = unicode ? UDX : SDX;
		o[pos++] = n << 5 | index >> 8;
		o[pos++] = index & 0xFF;
		dynamic[n] = 0x10000 + index * 0x80;
	} else {
		const x = defineIndex(c);
		o[pos++] = (unicode ? UD0 : SD0) + n;
		o[pos++] = x;
		dynamic[n] = windowOffset(x);
	}
	return pos;
}

// write c as UTF-16, quoted when quote is not 0, return the new position
function putUTF16(o, pos, c, quote) {
	if (c >= 0x10000) {
		const h = 0xD800 + ((c - 0x10000) >> 10);
		const l = 0xDC00 + ((c - 0x10000) & 0x3FF);
		if (quote)
			o[pos++] = quote;
		o[pos++] = h >> 8;
		o[pos++] = h & 0xFF;
		if (quote)
			o[pos++] = quote;
		o[pos++] = l >> 8;
		o[pos++] = l & 0xFF;
		return pos;
	}
	if (!quote && c >> 8 >= 0xE0 && c >> 8 <= 0xF2)
		quote = UQU;
	if (quote)
		o[pos++] = quote;
	o[pos++] = c >> 8;
	o[pos++] = c & 0xFF;
	return pos;
}

function encodePoints(count) {
	// no step writes more than four bytes per code point
	if (out.length < 4 * count)
		out = new Uint8Array(4 * count);
	const o = out, p = points, dynamic = encDynamic, stamp = encStamp;
	for (let n = 0; n < 8; ++n) {
		dynamic[n] = INITIAL_OFFSET[n];
		stamp[n] = 0;
	}
	let clock = 0, active = 0, unicode = false, pos = 0;
	for (let k = 0; k < count; ++k) {
		const c = p[k];
		const hasNext = k + 1 < count;
		const next = hasNext ? p[k + 1] : 0;
		// U+3400 to U+DFFF (CJK, Hangul) lie in no window and can't get one:
		// in unicode mode they are always written as they are
		if (unicode && c >= 0x3400 && c < 0xE000) {
			o[pos++] = c >> 8;
			o[pos++] = c & 0xFF;
			continue;
		}
		if (unicode) {
			// byteable(c) && (!hasNext || byteable(next))
			const isDirect = direct(c);
			const w = isDirect ? active : findWindow(dynamic, active, c);
			if (w >= 0 && (!hasNext || direct(next) || findWindow(dynamic, active, next) >= 0)) {
				active = w;
				unicode = false;
				stamp[w] = ++clock;
				o[pos++] = UC0 + w;
				// and on to byte mode for c
			} else if (hasNext && definable(c) && sameWindow(c, next)) {
				const n = oldest(stamp);
				pos = defineWindow(o, pos, dynamic, n, c, true);
				active = n;
				unicode = false;
				stamp[n] = ++clock;
				o[pos++] = 0x80 + c - dynamic[n];
				continue;
			} else {
				pos = putUTF16(o, pos, c, 0);
				continue;
			}
		}
		// a run of characters that are direct or in the active window needs no
		// lookahead and touches only the active window, so it is stamped once
		const lo = dynamic[active];
		if (direct(c) || (c >= lo && c < lo + 0x80)) {
			let d = c, touched = false;
			for (;;) {
				if (d < 0x80) {
					o[pos++] = d;
				} else {
					o[pos++] = 0x80 + d - lo;
					touched = true;
				}
				if (k + 1 >= count)
					break;
				d = p[k + 1];
				if (!direct(d) && !(d >= lo && d < lo + 0x80))
					break;
				++k;
			}
			if (touched)
				stamp[active] = ++clock;
			continue;
		}
		if (c < 0x80) {
			o[pos++] = SQ0;
			o[pos++] = c;
			continue;
		}
		let n = c >= 0x3400 && c < 0xE000 ? -1 : findWindow(dynamic, active, c);
		if (n >= 0) {
			stamp[n] = ++clock;
			if (n !== active) {
				if (hasNext && !direct(next) && next >= dynamic[n] && next < dynamic[n] + 0x80) {
					active = n;
					o[pos++] = SC0 + n;
				} else {
					o[pos++] = SQ0 + n;
				}
			}
			o[pos++] = 0x80 + c - dynamic[n];
			continue;
		}
		if ((c < 0x3400 || c >= 0xE000) && definable(c)) {
			if (!hasNext || !sameWindow(c, next)) {
				// isolated characters go through a static window where there is one
				for (n = 1; n < 8; ++n)
					if (c >= STATIC_OFFSET[n] && c < STATIC_OFFSET[n] + 0x80)
						break;
				if (n < 8) {
					o[pos++] = SQ0 + n;
					o[pos++] = c - STATIC_OFFSET[n];
					continue;
				}
			}
			n = oldest(stamp);
			pos = defineWindow(o, pos, dynamic, n, c, false);
			active = n;
			stamp[n] = ++clock;
			o[pos++] = 0x80 + c - dynamic[n];
			continue;
		}
		if (hasNext && !direct(next) && findWindow(dynamic, active, next) < 0) {
			unicode = true;
			o[pos++] = SCU;
			pos = putUTF16(o, pos, c, 0);
			continue;
		}
		pos = putUTF16(o, pos, c, SQU);
	}
	return o.slice(0, pos);
}

export function encode(str) {
	const count = stringToPoints(str);
	return count < 0 ? null : encodePoints(count);
}

export function encodeUTF8(bytes) {
	const count = utf8ToPoints(bytes);
	return count < 0 ? null : encodePoints(count);
}
