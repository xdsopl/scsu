/*
WebAssembly SCSU module for compressing Unicode text

Copyright 2026 Ahmet Inan <xdsopl@gmail.com>
*/

#define TLEN_MAX (1 << 20)
#define BUF_MAX (1 << 22)

__attribute__((visibility("default")))
unsigned char text[BUF_MAX];
__attribute__((visibility("default")))
unsigned char scsu[BUF_MAX];

static unsigned int points[TLEN_MAX];

static const unsigned int static_offset[8] = {
	0x0000, 0x0080, 0x0100, 0x0300, 0x2000, 0x2080, 0x2100, 0x3000
};

static const unsigned int initial_offset[8] = {
	0x0080, 0x00C0, 0x0400, 0x0600, 0x0900, 0x3040, 0x30A0, 0xFF00
};

static const unsigned int special_offset[7] = {
	0x00C0, 0x0250, 0x0370, 0x0530, 0x3040, 0x30A0, 0xFF60
};

enum {
	SQ0 = 0x01, SDX = 0x0B, SQU = 0x0E, SCU = 0x0F, SC0 = 0x10, SD0 = 0x18,
	UC0 = 0xE0, UD0 = 0xE8, UQU = 0xF0, UDX = 0xF1
};

static int window_offset(int x, unsigned int *offset)
{
	if (x < 1)
		return 1;
	if (x < 0x68) {
		*offset = x * 0x80;
		return 0;
	}
	if (x < 0xA8) {
		*offset = x * 0x80 + 0xAC00;
		return 0;
	}
	if (x < 0xF9)
		return 1;
	*offset = special_offset[x-0xF9];
	return 0;
}

static int put_utf8(unsigned int c, int *pos)
{
	int p = *pos;
	if (c < 0x80) {
		if (p + 1 > BUF_MAX)
			return 1;
		text[p++] = c;
	} else if (c < 0x800) {
		if (p + 2 > BUF_MAX)
			return 1;
		text[p++] = 0xC0 | c >> 6;
		text[p++] = 0x80 | (c & 0x3F);
	} else if (c < 0x10000) {
		if (p + 3 > BUF_MAX)
			return 1;
		text[p++] = 0xE0 | c >> 12;
		text[p++] = 0x80 | (c >> 6 & 0x3F);
		text[p++] = 0x80 | (c & 0x3F);
	} else {
		if (p + 4 > BUF_MAX)
			return 1;
		text[p++] = 0xF0 | c >> 18;
		text[p++] = 0x80 | (c >> 12 & 0x3F);
		text[p++] = 0x80 | (c >> 6 & 0x3F);
		text[p++] = 0x80 | (c & 0x3F);
	}
	*pos = p;
	return 0;
}

/* emit a code point that is not a surrogate, unless a high surrogate waits */
static int put_point(unsigned int c, unsigned int *high, int *pos)
{
	if (*high)
		return 1;
	if (c > 0x10FFFF || (c >= 0xD800 && c < 0xE000))
		return 1;
	return put_utf8(c, pos);
}

/* emit one UTF-16 code unit, pairing surrogates */
static int put_unit(unsigned int u, unsigned int *high, int *pos)
{
	if (*high) {
		unsigned int h = *high;
		if (u < 0xDC00 || u >= 0xE000)
			return 1;
		*high = 0;
		return put_utf8(0x10000 + ((h - 0xD800) << 10) + (u - 0xDC00), pos);
	}
	if (u >= 0xD800 && u < 0xDC00) {
		*high = u;
		return 0;
	}
	if (u >= 0xDC00 && u < 0xE000)
		return 1;
	return put_utf8(u, pos);
}

__attribute__((visibility("default")))
int scsu_decode(int slen)
{
	unsigned int dynamic[8];
	unsigned int high = 0;
	int unicode = 0, window = 0, pos = 0, i = 0, n;
	if (slen < 0 || slen > TLEN_MAX)
		return -1;
	for (n = 0; n < 8; ++n)
		dynamic[n] = initial_offset[n];
	while (i < slen) {
		unsigned int b = scsu[i++];
		if (!unicode) {
			if (b >= 0x80) {
				if (put_point(dynamic[window] + b - 0x80, &high, &pos))
					return -1;
			} else if (b >= 0x20 || b == 0x00 || b == 0x09 || b == 0x0A || b == 0x0D) {
				if (put_point(b, &high, &pos))
					return -1;
			} else if (b >= SQ0 && b < SQ0 + 8) {
				unsigned int t, c;
				if (i >= slen)
					return -1;
				t = scsu[i++];
				n = b - SQ0;
				c = t < 0x80 ? static_offset[n] + t : dynamic[n] + t - 0x80;
				if (put_point(c, &high, &pos))
					return -1;
			} else if (b == SDX) {
				unsigned int h, l;
				if (i + 2 > slen)
					return -1;
				h = scsu[i++];
				l = scsu[i++];
				window = h >> 5;
				dynamic[window] = 0x10000 + (((h & 0x1F) << 8) | l) * 0x80;
			} else if (b == SQU) {
				if (i + 2 > slen)
					return -1;
				if (put_unit(scsu[i] << 8 | scsu[i+1], &high, &pos))
					return -1;
				i += 2;
			} else if (b == SCU) {
				unicode = 1;
			} else if (b >= SC0 && b < SC0 + 8) {
				window = b - SC0;
			} else if (b >= SD0 && b < SD0 + 8) {
				if (i >= slen)
					return -1;
				window = b - SD0;
				if (window_offset(scsu[i++], dynamic+window))
					return -1;
			} else {
				return -1;
			}
		} else {
			if (b >= UC0 && b < UC0 + 8) {
				window = b - UC0;
				unicode = 0;
			} else if (b >= UD0 && b < UD0 + 8) {
				if (i >= slen)
					return -1;
				window = b - UD0;
				if (window_offset(scsu[i++], dynamic+window))
					return -1;
				unicode = 0;
			} else if (b == UQU) {
				if (i + 2 > slen)
					return -1;
				if (put_unit(scsu[i] << 8 | scsu[i+1], &high, &pos))
					return -1;
				i += 2;
			} else if (b == UDX) {
				unsigned int h, l;
				if (i + 2 > slen)
					return -1;
				h = scsu[i++];
				l = scsu[i++];
				window = h >> 5;
				dynamic[window] = 0x10000 + (((h & 0x1F) << 8) | l) * 0x80;
				unicode = 0;
			} else if (b == 0xF2) {
				return -1;
			} else {
				if (i >= slen)
					return -1;
				if (put_unit(b << 8 | scsu[i++], &high, &pos))
					return -1;
			}
		}
	}
	if (high)
		return -1;
	return pos;
}

static int get_points(int tlen)
{
	int i = 0, count = 0;
	while (i < tlen) {
		unsigned int b = text[i++], c, min;
		int more, k;
		if (b < 0x80) {
			points[count++] = b;
			continue;
		}
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
		for (k = 0; k < more; ++k) {
			unsigned int t = text[i++];
			if ((t & 0xC0) != 0x80)
				return -1;
			c = c << 6 | (t & 0x3F);
		}
		if (c < min || c > 0x10FFFF || (c >= 0xD800 && c < 0xE000))
			return -1;
		points[count++] = c;
	}
	return count;
}

struct encoder {
	unsigned int dynamic[8];
	unsigned int stamp[8];
	unsigned int clock;
	int window;
	int unicode;
	int pos;
};

static int put(struct encoder *e, unsigned int b)
{
	if (e->pos >= BUF_MAX)
		return 1;
	scsu[e->pos++] = b;
	return 0;
}

static int direct(unsigned int c)
{
	return (c >= 0x20 && c < 0x80) || c == 0x00 || c == 0x09 || c == 0x0A || c == 0x0D;
}

static int find_window(struct encoder *e, unsigned int c)
{
	int n;
	if (c < e->dynamic[e->window] + 0x80 && c >= e->dynamic[e->window])
		return e->window;
	for (n = 0; n < 8; ++n)
		if (c >= e->dynamic[n] && c < e->dynamic[n] + 0x80)
			return n;
	return -1;
}

/* window index x for SDn, or -1 if c can't be reached through a BMP window */
static int define_index(unsigned int c)
{
	int x;
	for (x = 0; x < 7; ++x)
		if (c >= special_offset[x] && c < special_offset[x] + 0x80)
			return 0xF9 + x;
	if (c >= 0x80 && c < 0x3400)
		return c >> 7;
	if (c >= 0xE000 && c < 0x10000)
		return (c - 0xAC00) >> 7;
	return -1;
}

static int same_window(unsigned int a, unsigned int b)
{
	if (a >= 0x10000)
		return b >= 0x10000 && (a >> 7) == (b >> 7);
	{
		unsigned int offset;
		int x = define_index(a);
		if (x < 0 || window_offset(x, &offset))
			return 0;
		return b >= offset && b < offset + 0x80;
	}
}

static int oldest(struct encoder *e)
{
	int n, best = 0;
	for (n = 1; n < 8; ++n)
		if (e->stamp[n] < e->stamp[best])
			best = n;
	return best;
}

static void touch(struct encoder *e, int n)
{
	e->stamp[n] = ++e->clock;
}

/* define a window for c with tag SDn/SDX (single-byte) or UDn/UDX (unicode) */
static int define(struct encoder *e, unsigned int c)
{
	int n = oldest(e);
	if (c >= 0x10000) {
		unsigned int index = (c - 0x10000) >> 7;
		if (put(e, e->unicode ? UDX : SDX) || put(e, n << 5 | index >> 8) || put(e, index & 0xFF))
			return 1;
		e->dynamic[n] = 0x10000 + index * 0x80;
	} else {
		int x = define_index(c);
		if (put(e, (e->unicode ? UD0 : SD0) + n) || put(e, x))
			return 1;
		window_offset(x, e->dynamic+n);
	}
	e->window = n;
	e->unicode = 0;
	touch(e, n);
	return 0;
}

static int put_utf16(struct encoder *e, unsigned int c, unsigned int quote)
{
	if (c >= 0x10000) {
		unsigned int h = 0xD800 + ((c - 0x10000) >> 10);
		unsigned int l = 0xDC00 + ((c - 0x10000) & 0x3FF);
		if (quote && put(e, quote))
			return 1;
		if (put(e, h >> 8) || put(e, h & 0xFF))
			return 1;
		if (quote && put(e, quote))
			return 1;
		return put(e, l >> 8) || put(e, l & 0xFF);
	}
	if (!quote && c >> 8 >= 0xE0 && c >> 8 <= 0xF2)
		quote = UQU;
	if (quote && put(e, quote))
		return 1;
	return put(e, c >> 8) || put(e, c & 0xFF);
}

/* can c be written as a single byte without defining a window */
static int byteable(struct encoder *e, unsigned int c)
{
	return direct(c) || find_window(e, c) >= 0;
}

static int encode_byte_mode(struct encoder *e, int k, int count)
{
	unsigned int c = points[k];
	int has_next = k + 1 < count;
	unsigned int next = has_next ? points[k+1] : 0;
	int n;
	if (direct(c))
		return put(e, c);
	if (c < 0x80)
		return put(e, SQ0) || put(e, c);
	n = find_window(e, c);
	if (n >= 0) {
		touch(e, n);
		if (n == e->window)
			return put(e, 0x80 + c - e->dynamic[n]);
		if (has_next && !direct(next) && next >= e->dynamic[n] && next < e->dynamic[n] + 0x80) {
			e->window = n;
			return put(e, SC0 + n) || put(e, 0x80 + c - e->dynamic[n]);
		}
		return put(e, SQ0 + n) || put(e, 0x80 + c - e->dynamic[n]);
	}
	if (c >= 0x10000 || define_index(c) >= 0) {
		if (!has_next || !same_window(c, next))
			for (n = 1; n < 8; ++n)
				if (c >= static_offset[n] && c < static_offset[n] + 0x80)
					return put(e, SQ0 + n) || put(e, c - static_offset[n]);
		if (define(e, c))
			return 1;
		return put(e, 0x80 + c - e->dynamic[e->window]);
	}
	if (has_next && !byteable(e, next)) {
		e->unicode = 1;
		if (put(e, SCU))
			return 1;
		return put_utf16(e, c, 0);
	}
	return put_utf16(e, c, SQU);
}

static int encode_unicode_mode(struct encoder *e, int k, int count)
{
	unsigned int c = points[k];
	int has_next = k + 1 < count;
	unsigned int next = has_next ? points[k+1] : 0;
	if (byteable(e, c) && (!has_next || byteable(e, next))) {
		int n = direct(c) ? e->window : find_window(e, c);
		e->window = n;
		e->unicode = 0;
		touch(e, n);
		if (put(e, UC0 + n))
			return 1;
		return encode_byte_mode(e, k, count);
	}
	if ((c >= 0x10000 || define_index(c) >= 0) && has_next && same_window(c, next)) {
		if (define(e, c))
			return 1;
		return put(e, 0x80 + c - e->dynamic[e->window]);
	}
	return put_utf16(e, c, 0);
}

__attribute__((visibility("default")))
int scsu_encode(int tlen)
{
	struct encoder e;
	int count, k, n;
	if (tlen < 0 || tlen > TLEN_MAX)
		return -1;
	count = get_points(tlen);
	if (count < 0)
		return -1;
	for (n = 0; n < 8; ++n) {
		e.dynamic[n] = initial_offset[n];
		e.stamp[n] = 0;
	}
	e.clock = 0;
	e.window = 0;
	e.unicode = 0;
	e.pos = 0;
	for (k = 0; k < count; ++k) {
		int ret = e.unicode ? encode_unicode_mode(&e, k, count) : encode_byte_mode(&e, k, count);
		if (ret)
			return -1;
	}
	return e.pos;
}
