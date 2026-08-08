#!/bin/sh
# Round-trip timing baseline.
#
# Sends N notes at exact intervals via CoreMIDI (which schedules them in the
# kernel, so the send side is as tight as this machine can be) and measures the
# MPC's echo. Whatever jitter shows up here is the floor of the measurement
# itself: the MPC's soft-thru plus the USB link. Any phone result has to be read
# against this number, not against zero.
#
#   tools/midi/jitter.sh [count] [spacing-ms]
set -e
cd "$(dirname "$0")"
COUNT=${1:-16}
SPACING=${2:-125}

[ -x ./mpcmidi ] || make >/dev/null

./mpcmidi monitor "MPC Sample" $(echo "$COUNT * $SPACING / 1000 + 2" | bc) > /tmp/jitter.txt 2>&1 &
MON=$!
sleep 0.5

awk -v c="$COUNT" -v s="$SPACING" 'BEGIN{
  for (i = 0; i < c; i++) { printf "%d 90 24 01\n", i*s; printf "%d 80 24 00\n", i*s+30 }
}' | ./mpcmidi play "MPC Sample" >/dev/null 2>&1

wait $MON

awk -v s="$SPACING" '
  $2 == "90" && $4 != "00" { t[n++] = $1 }
  END {
    if (n < 2) { print "no echo received - is MIDI soft-thru on?"; exit }
    worst = 0; sum = 0
    for (i = 1; i < n; i++) {
      err = (t[i] - t[0]) - i*s
      if (err < 0) err = -err
      if (err > worst) worst = err
      sum += err
    }
    printf "round-trip baseline: %d notes, mean %.1fms, worst %.1fms\n", n, sum/(n-1), worst
  }
' /tmp/jitter.txt
