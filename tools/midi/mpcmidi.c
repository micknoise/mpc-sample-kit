// mpcmidi — a tiny zero-dependency CoreMIDI CLI for driving the Akai MPC Sample.
//
//   mpcmidi list
//   mpcmidi send <port-substring> <hex-byte>...
//   mpcmidi monitor <port-substring> [seconds]
//
// Port matching is a case-insensitive substring, so "mpc" finds "MPC Sample".
// Build: make

#include <CoreMIDI/CoreMIDI.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static void obj_name(MIDIObjectRef obj, char *out, size_t n) {
    CFStringRef s = NULL;
    out[0] = '\0';
    if (MIDIObjectGetStringProperty(obj, kMIDIPropertyDisplayName, &s) == noErr && s) {
        CFStringGetCString(s, out, (CFIndex)n, kCFStringEncodingUTF8);
        CFRelease(s);
    }
}

static MIDIEndpointRef find_endpoint(const char *needle, int is_source) {
    ItemCount n = is_source ? MIDIGetNumberOfSources() : MIDIGetNumberOfDestinations();
    char nm[256];
    for (ItemCount i = 0; i < n; i++) {
        MIDIEndpointRef e = is_source ? MIDIGetSource(i) : MIDIGetDestination(i);
        obj_name(e, nm, sizeof nm);
        if (strcasestr(nm, needle)) return e;
    }
    return 0;
}

static int cmd_list(void) {
    char nm[256];
    printf("sources (device -> mac):\n");
    for (ItemCount i = 0; i < MIDIGetNumberOfSources(); i++) {
        obj_name(MIDIGetSource(i), nm, sizeof nm);
        printf("  [%lu] %s\n", (unsigned long)i, nm);
    }
    printf("destinations (mac -> device):\n");
    for (ItemCount i = 0; i < MIDIGetNumberOfDestinations(); i++) {
        obj_name(MIDIGetDestination(i), nm, sizeof nm);
        printf("  [%lu] %s\n", (unsigned long)i, nm);
    }
    return 0;
}

static int cmd_send(const char *port, int argc, char **argv) {
    MIDIEndpointRef dest = find_endpoint(port, 0);
    if (!dest) { fprintf(stderr, "mpcmidi: no destination matching '%s'\n", port); return 1; }

    Byte data[65536];
    int len = 0;
    for (int i = 0; i < argc && len < (int)sizeof data; i++) {
        data[len++] = (Byte)strtol(argv[i], NULL, 16);
    }
    if (!len) { fprintf(stderr, "mpcmidi: no bytes to send\n"); return 1; }

    MIDIClientRef client; MIDIPortRef out;
    MIDIClientCreate(CFSTR("mpcmidi"), NULL, NULL, &client);
    MIDIOutputPortCreate(client, CFSTR("out"), &out);

    Byte buf[65536 + 128];
    MIDIPacketList *pl = (MIDIPacketList *)buf;
    MIDIPacket *cur = MIDIPacketListInit(pl);
    cur = MIDIPacketListAdd(pl, sizeof buf, cur, 0, len, data);
    if (!cur) { fprintf(stderr, "mpcmidi: packet too large\n"); return 1; }

    OSStatus st = MIDISend(out, dest, pl);
    if (st != noErr) { fprintf(stderr, "mpcmidi: MIDISend failed (%d)\n", (int)st); return 1; }
    // Give CoreMIDI a moment to flush before the process exits.
    usleep(20000);
    return 0;
}

static void read_proc(const MIDIPacketList *pl, void *refCon, void *srcRefCon) {
    (void)refCon; (void)srcRefCon;
    const MIDIPacket *p = &pl->packet[0];
    for (unsigned i = 0; i < pl->numPackets; i++) {
        for (UInt16 j = 0; j < p->length; j++) printf("%02X ", p->data[j]);
        printf("\n");
        fflush(stdout);
        p = MIDIPacketNext(p);
    }
}

static int cmd_monitor(const char *port, double seconds) {
    MIDIEndpointRef src = find_endpoint(port, 1);
    if (!src) { fprintf(stderr, "mpcmidi: no source matching '%s'\n", port); return 1; }

    MIDIClientRef client; MIDIPortRef in;
    MIDIClientCreate(CFSTR("mpcmidi"), NULL, NULL, &client);
    MIDIInputPortCreate(client, CFSTR("in"), read_proc, NULL, &in);
    MIDIPortConnectSource(in, src, NULL);

    CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false);
    return 0;
}

static uint64_t ns_to_host(uint64_t ns) {
    static mach_timebase_info_data_t tb;
    if (!tb.denom) mach_timebase_info(&tb);
    return ns * tb.denom / tb.numer;
}

// Plays a timestamped event stream read from stdin. Each line is:
//
//     <offset-ms> <hex-byte>...
//
// Offsets are milliseconds from playback start and must be ascending. Events
// are handed to CoreMIDI with absolute timestamps up front, so delivery timing
// is owned by CoreMIDI's own high-priority thread rather than by this process
// being scheduled — which is what makes the timing tight enough for music.
static int cmd_play(const char *port) {
    MIDIEndpointRef dest = find_endpoint(port, 0);
    if (!dest) { fprintf(stderr, "mpcmidi: no destination matching '%s'\n", port); return 1; }

    MIDIClientRef client; MIDIPortRef out;
    MIDIClientCreate(CFSTR("mpcmidi"), NULL, NULL, &client);
    MIDIOutputPortCreate(client, CFSTR("out"), &out);

    // Start slightly in the future so the first events are not already late.
    const uint64_t lead_ms = 100;
    uint64_t start = mach_absolute_time() + ns_to_host(lead_ms * 1000000ULL);

    static Byte buf[512 * 1024];
    MIDIPacketList *pl = (MIDIPacketList *)buf;
    MIDIPacket *cur = MIDIPacketListInit(pl);

    char line[4096];
    double last_ms = 0;
    long queued = 0, sent = 0;

    while (fgets(line, sizeof line, stdin)) {
        char *save = NULL;
        char *tok = strtok_r(line, " \t\r\n", &save);
        if (!tok || *tok == '#') continue;

        double off_ms = atof(tok);
        Byte data[1024];
        int len = 0;
        while ((tok = strtok_r(NULL, " \t\r\n", &save)) && len < (int)sizeof data)
            data[len++] = (Byte)strtol(tok, NULL, 16);
        if (!len) continue;

        if (off_ms > last_ms) last_ms = off_ms;
        MIDITimeStamp ts = start + ns_to_host((uint64_t)(off_ms * 1000000.0));

        MIDIPacket *next = MIDIPacketListAdd(pl, sizeof buf, cur, ts, len, data);
        if (!next) {                      // buffer full — flush and start a new list
            MIDISend(out, dest, pl);
            sent += queued; queued = 0;
            cur = MIDIPacketListInit(pl);
            next = MIDIPacketListAdd(pl, sizeof buf, cur, ts, len, data);
            if (!next) { fprintf(stderr, "mpcmidi: event too large\n"); return 1; }
        }
        cur = next;
        queued++;
    }

    if (queued) {
        OSStatus st = MIDISend(out, dest, pl);
        if (st != noErr) { fprintf(stderr, "mpcmidi: MIDISend failed (%d)\n", (int)st); return 1; }
        sent += queued;
    }
    fprintf(stderr, "mpcmidi: scheduled %ld events over %.2fs\n", sent, last_ms / 1000.0);

    // Stay alive until CoreMIDI has delivered the final event.
    usleep((useconds_t)((last_ms + lead_ms + 250) * 1000));
    return 0;
}

// Creates a virtual MIDI source that emits a note every 500ms. Used to prove the
// monitor path works independently of any attached hardware.
static int cmd_testsrc(double seconds) {
    MIDIClientRef client; MIDIEndpointRef src;
    MIDIClientCreate(CFSTR("mpcmidi"), NULL, NULL, &client);
    if (MIDISourceCreate(client, CFSTR("mpcmidi-testsrc"), &src) != noErr) {
        fprintf(stderr, "mpcmidi: could not create virtual source\n");
        return 1;
    }
    for (int i = 0; i < (int)(seconds * 2); i++) {
        Byte note[3] = { 0x90, 0x3C, 0x7F };
        Byte buf[256];
        MIDIPacketList *pl = (MIDIPacketList *)buf;
        MIDIPacket *cur = MIDIPacketListInit(pl);
        cur = MIDIPacketListAdd(pl, sizeof buf, cur, 0, 3, note);
        MIDIReceived(src, pl);
        usleep(500000);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
            "usage: mpcmidi list\n"
            "       mpcmidi send <port> <hex>...\n"
            "       mpcmidi play <port>            # timestamped events on stdin\n"
            "       mpcmidi monitor <port> [seconds]\n"
            "       mpcmidi testsrc [seconds]\n");
        return 2;
    }
    if (!strcmp(argv[1], "testsrc")) return cmd_testsrc(argc >= 3 ? atof(argv[2]) : 5.0);
    if (!strcmp(argv[1], "play") && argc >= 3) return cmd_play(argv[2]);
    if (!strcmp(argv[1], "list")) return cmd_list();
    if (!strcmp(argv[1], "send") && argc >= 4) return cmd_send(argv[2], argc - 3, argv + 3);
    if (!strcmp(argv[1], "monitor") && argc >= 3)
        return cmd_monitor(argv[2], argc >= 4 ? atof(argv[3]) : 10.0);
    fprintf(stderr, "mpcmidi: bad arguments\n");
    return 2;
}
