BIN := mpcmidi
CFLAGS := -O2 -Wall -Wno-deprecated-declarations
LDFLAGS := -framework CoreMIDI -framework CoreFoundation

$(BIN): mpcmidi.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(BIN)

.PHONY: clean
