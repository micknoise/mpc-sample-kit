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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
        fprintf(stderr, "usage: mpcmidi list | send <port> <hex>... | monitor <port> [seconds] | testsrc [seconds]\n");
        return 2;
    }
    if (!strcmp(argv[1], "testsrc")) return cmd_testsrc(argc >= 3 ? atof(argv[2]) : 5.0);
    if (!strcmp(argv[1], "list")) return cmd_list();
    if (!strcmp(argv[1], "send") && argc >= 4) return cmd_send(argv[2], argc - 3, argv + 3);
    if (!strcmp(argv[1], "monitor") && argc >= 3)
        return cmd_monitor(argv[2], argc >= 4 ? atof(argv[3]) : 10.0);
    fprintf(stderr, "mpcmidi: bad arguments\n");
    return 2;
}
