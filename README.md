# Adaptalux pod control

Drives Adaptalux lighting pods (Pod Mini 2.0, Control Pod 3.0) over Bluetooth from a
computer, in place of the phone app. The computer runs a small server; any phone, tablet or
browser on the same network opens the page and controls the lights, and every open page sees
the same state live.

Built by Barret Robinson for his macro studio, and shared with Adaptalux.

## What it does

- **Set-up:** turn the pods on in Bluetooth mode (flashing blue), close the phone app, and
  *Scan*. Add each pod; every port becomes an arm (a Pod Mini has one, a Control Pod five).
  Tap an arm's name to rename it. Addresses can also be typed in.
- **Connect** takes the pods away from the phone app until *Disconnect*; the pods' own buttons
  still work. Connecting never changes the light: the sliders start from what each pod reports.
  **Sim** connects simulated pods, for trying the page without hardware.
- **Arms:** a slider and an On switch each, *All on 100%* and *All off*, and *no arm* when a pod
  reports nothing plugged into that port. Every change is confirmed by the pod's own status
  report; a pod that does not answer in 2 s is reported.
- **What's plugged in, and where:** the icon before an arm's name says what kind of arm it is
  (White, Super Bright, Warm White, Cold White, UV, Red, Green, Blue, Yellow or a Xenon flash
  arm; tap it to pick), and the tag after it draws the pod's face with that port lit. Pods can
  be renamed too (tap the name under Set-up); the pod picture there fills in the ports that
  report an arm.
- **Boost** (a switch per pod under Set-up): on, the arms get the level set; off, the pod drives
  them at a third of it, which is what it reports back. Connecting leaves Boost as the pod has it.
- **Looks:** set the sliders, name the look, *Save look*. *Apply* sets every arm (arms the look
  leaves out go off).
- **Rave:** a random light show, one change per beat, 40 to 180 BPM. 180 is three changes a
  second, kept under the 3 Hz where flashing light can trigger photosensitive seizures.
- Works as a home-screen app on a phone (*Share > Add to Home Screen*).

## Running it

Needs Node.js 22.13 or newer and a Bluetooth adapter on the computer that runs the server
(Windows 10/11, macOS, or Linux with BlueZ).

```
npm install
npm start
```

Then open `http://localhost:4810` here, or `http://<this computer>:4810` from a phone on the
same network (the server prints the addresses). `PORT=4811 npm start` picks another port;
`HOST=127.0.0.1` keeps it on this computer only.

On Windows, `windows\setup.cmd` does the same and also starts the server hidden at logon,
allows the port through the firewall, and adds a Startup shortcut; `windows\restart.cmd` and
`windows\stop.cmd` manage it, and `windows\setup.cmd -Uninstall` removes it again.

The set-up and the looks are kept in `data\pods.db` next to the app. `npm test` runs the
tests against the pod simulator, no hardware needed.

## How it talks to the pods

The pods use a Microchip Transparent UART service over Bluetooth LE, no pairing: `#` asks for
an 11-byte status frame, and `77 L0..L4 BB [#]` sets every lamp (levels inverted, lamp order
ports 2, 1, 3, 4, 5, then the boost byte). `lib/pods/protocol.js` has the full notes; the
Bluetooth side is `lib/pods/ble.js` on `@stoprocent/noble`, and `lib/pods/sim.js` is a
firmware emulator the tests and *Sim* run against.

Pod 1.0 (`Adaptalx`, a different service) and the xenon flash arms are not supported yet.

## Layout

```
server.js              the server: port, host, database file
lib/app.js             the HTTP API (/api/pods, /api/pods/events) and static files
lib/db.js              the SQLite file (set-up and looks)
lib/pods/              protocol, simulator, one pod, the manager, Bluetooth
public/                the page (index.html), js/pods.js is the card, js/pods-app.js boots it
test/pods.test.js      the tests
windows/               setup.cmd, start/stop/restart for Windows
```
