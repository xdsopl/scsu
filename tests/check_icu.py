#!/usr/bin/env python3
# cross-check the SCSU module against ICU's SCSU converter
import ctypes, ctypes.util, glob, random, sys

lib = ctypes.CDLL(sys.argv[1])
BUF = 1 << 22
text = (ctypes.c_ubyte * BUF).in_dll(lib, "text")
scsu = (ctypes.c_ubyte * BUF).in_dll(lib, "scsu")

# any installed ICU: its library name and symbols carry the major version
def load_icu():
	names = [ctypes.util.find_library("icuuc")]
	names += sorted(glob.glob("/usr/lib*/libicuuc.so*") + glob.glob("/usr/lib/*/libicuuc.so*"), reverse=True)
	for name in names:
		if not name:
			continue
		try:
			icu = ctypes.CDLL(name)
		except OSError:
			continue
		for suffix in [""] + ["_%d" % v for v in range(99, 49, -1)]:
			if hasattr(icu, "ucnv_open" + suffix):
				return icu, suffix
	sys.exit("ICU's libicuuc not found")

icu, suffix = load_icu()

def icu_function(name, restype, argtypes):
	f = getattr(icu, name + suffix)
	f.restype = restype
	f.argtypes = argtypes
	return f

ucnv_open = icu_function("ucnv_open", ctypes.c_void_p, [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)])
ucnv_from = icu_function("ucnv_fromUChars", ctypes.c_int32, [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_char_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int)])
ucnv_to = icu_function("ucnv_toUChars", ctypes.c_int32, [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_char_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int)])
ucnv_reset = icu_function("ucnv_reset", None, [ctypes.c_void_p])

err = ctypes.c_int(0)
conv = ucnv_open(b"SCSU", ctypes.byref(err))
assert err.value <= 0 and conv

def icu_encode(s):
	u = s.encode("utf-16-le")
	out = ctypes.create_string_buffer(4 * len(u) + 16)
	err = ctypes.c_int(0)
	ucnv_reset(conv)
	n = ucnv_from(conv, out, len(out), u, len(u) // 2, ctypes.byref(err))
	assert err.value <= 0, err.value
	return out.raw[:n]

def icu_decode(b):
	out = ctypes.create_string_buffer(4 * len(b) + 16)
	err = ctypes.c_int(0)
	ucnv_reset(conv)
	n = ucnv_to(conv, out, len(out) // 2, b, len(b), ctypes.byref(err))
	assert err.value <= 0, err.value
	return out.raw[:2 * n].decode("utf-16-le")

def my_encode(s):
	u = s.encode("utf-8")
	ctypes.memmove(text, u, len(u))
	n = lib.scsu_encode(len(u))
	assert n >= 0
	return bytes(scsu[:n])

def my_decode(b):
	ctypes.memmove(scsu, b, len(b))
	n = lib.scsu_decode(len(b))
	if n < 0:
		return None
	return bytes(text[:n]).decode("utf-8")

samples = {
	"English": "Hungry. Anyone around 40m tonight? 73 de DL1ABC",
	"German": "Grüße aus Köln, wir hören uns auf 80 m. Schöne Größe!",
	"French": "Ça va être génial, à bientôt près de la côte.",
	"Russian": "Привет всем! Кто сегодня на 40 метрах? Хочу есть.",
	"Greek": "Γεια σας από την Αθήνα, πεινάω πολύ σήμερα.",
	"Arabic": "مرحبا بالجميع، أنا جائع جدا اليوم.",
	"Hebrew": "שלום לכולם, אני רעב מאוד היום.",
	"Hindi": "नमस्ते सबको, आज मुझे बहुत भूख लगी है।",
	"Bengali": "সবাইকে নমস্কার, আজ আমার খুব খিদে পেয়েছে।",
	"Tamil": "அனைவருக்கும் வணக்கம், இன்று எனக்கு மிகவும் பசிக்கிறது.",
	"Thai": "สวัสดีทุกคน วันนี้ฉันหิวมาก",
	"Japanese": "皆さんこんにちは、今日はとてもお腹が空いています。",
	"Chinese": "大家好，我今天非常饿。今晚有人在四十米波段吗？",
	"Korean": "안녕하세요 여러분, 오늘 정말 배고파요.",
	"Emoji": "Hungry 🍕🍔 now 😋 73!",
	"Mixed": "QSL via büro. 東京 → Москва ✈ नमस्ते 𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
}

print(f"{'script':10} {'UTF-8':>6} {'ours':>5} {'ICU':>5}")
for name, s in samples.items():
	mine = my_encode(s)
	theirs = icu_encode(s)
	assert icu_decode(mine) == s, f"ICU can't read ours: {name}"
	assert my_decode(theirs) == s, f"we can't read ICU's: {name}"
	assert my_decode(mine) == s, f"round trip: {name}"
	print(f"{name:10} {len(s.encode('utf-8')):6} {len(mine):5} {len(theirs):5}")

# random strings drawn from mixed blocks, including private use and supplementary planes
blocks = [(0x20, 0x7F), (0x00, 0x20), (0x80, 0x250), (0x370, 0x400), (0x400, 0x530),
	(0x590, 0x700), (0x900, 0xE00), (0x2000, 0x2200), (0x3000, 0x3100),
	(0x4E00, 0x9FFF), (0xAC00, 0xD7A3), (0xE000, 0xF900), (0xFE00, 0x10000),
	(0x10000, 0x10400), (0x1F300, 0x1FAFF), (0x20000, 0x2A6DF), (0xF0000, 0x10FFFF)]
rng = random.Random(1)
worse = 0
for t in range(20000):
	s = []
	for r in range(rng.randrange(1, 6)):
		lo, hi = rng.choice(blocks)
		s += [chr(rng.randrange(lo, hi)) for _ in range(rng.randrange(1, 30))]
	s = "".join(c for c in s if not 0xD800 <= ord(c) < 0xE000)
	if not s:
		continue
	mine = my_encode(s)
	theirs = icu_encode(s)
	assert icu_decode(mine) == s, ("ICU can't read ours", s)
	assert my_decode(theirs) == s, ("we can't read ICU's", s)
	assert my_decode(mine) == s, ("round trip", s)
	if len(mine) > len(theirs):
		worse += 1
print(f"random: 20000 strings ok, ours longer than ICU's in {worse}")

# malformed input must be refused, never crash
for b in [b"\x0c", b"\x0e\xd8\x00", b"\x0f\xdc\x00", b"\x01", b"\x18\x00", b"\x18\xb0", b"\x0f\xf2", b"\x0f\xe8\x00"]:
	assert my_decode(b) is None, b
for t in range(20000):
	b = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 40)))
	my_decode(b)
print("malformed and random bytes: ok")
