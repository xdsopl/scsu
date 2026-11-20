# WebAssembly SCSU module for compressing Unicode text
# Copyright 2026 Ahmet Inan <xdsopl@gmail.com>

CC = clang
CFLAGS = -ffreestanding -fvisibility=hidden --target=wasm32
LDFLAGS = -nostdlib -Wl,--export-dynamic,--no-entry

CFLAGS += -std=c89 -W -Wall -pedantic -O2

docs/scsu.wasm: temp/scsu.wasm
	mkdir -p docs
	cp $< $@

docs/scsu.js: module/scsu.js
	mkdir -p docs
	cp $< $@

temp/scsu.wasm: temp/scsu.o
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^

temp/scsu.o: module/scsu.c
	mkdir -p temp
	$(CC) $(CFLAGS) -c -o $@ $<

temp/libscsu.so: module/scsu.c
	mkdir -p temp
	gcc -std=c89 -W -Wall -pedantic -O2 -shared -fPIC -o $@ $<

.PHONY: check webserver clean

check: temp/libscsu.so docs/scsu.wasm docs/scsu.js
	python3 -I tests/check_icu.py temp/libscsu.so
	node tests/check_wasm.mjs docs/scsu.wasm
	node tests/check_js.mjs docs/scsu.wasm

webserver:
	python3 -m http.server 8080 --bind 127.0.0.1 --directory docs

clean:
	rm -f temp/*.o temp/*.wasm temp/*.so
