# Charlie Print Relay

Fixes the conflict where pairing a receipt printer with Charlie via WebUSB
(the Zadig/WinUSB fix) makes Windows "forget" the printer for every other
program — including Humble, used as the fallback till. This relay prints
through the printer's **normal, shared** Windows driver instead, so it stays
usable by any program at the same time.

## One-time setup (per till)

### 1. Share the printer in Windows

1. Control Panel → Devices and Printers
2. Right-click the receipt printer → **Printer properties**
3. **Sharing** tab → check **Share this printer** → note the **Share name**
   (e.g. `EPSON_TM88`) — you'll need it in step 3 below.
4. Click OK.

If the printer was previously "fixed" with Zadig for WebUSB, undo that first
so Windows has its normal driver back:
- Device Manager → find the printer (it may show under "Universal Serial Bus
  devices" instead of "Printers" after the Zadig fix)
- Right-click → Uninstall device
- Unplug and replug the printer — Windows should reinstall its normal driver
  automatically. If not, reinstall the manufacturer's driver.

### 2. Install Node.js (if not already on this till)

Download and run the installer from https://nodejs.org (the "LTS" version).
One-time install, same idea as installing Zadig was.

### 3. Configure the relay

1. Copy this whole `local-print-relay` folder onto the till PC (e.g. to
   `C:\CharliePrintRelay`).
2. Copy `config.example.json` to `config.json`.
3. Open `config.json` and set `printerShareName` to the share name from
   step 1.

### 4. Run it

Double-click `start-relay.bat`. Leave the window open (minimize it) — this
is what Charlie talks to whenever it needs to print or open the cash drawer.

### 5. Make it start automatically (recommended)

So cashiers never have to remember to launch it:

1. Press `Win+R`, type `shell:startup`, press Enter — this opens the Windows
   Startup folder.
2. Right-click `start-relay.bat` → **Create shortcut**.
3. Drag that shortcut into the Startup folder.

Now it launches automatically every time the till PC starts.

## How Charlie uses this

Charlie tries this relay first (`http://127.0.0.1:9123`) before falling back
to WebUSB, then the browser print dialog. If this relay isn't running on a
given till, nothing breaks — Charlie just falls back exactly like it did
before this existed. You can migrate tills to this one at a time.

## Verifying it's working

With the relay running, open `http://127.0.0.1:9123/status` in a browser on
the till — it should show `"ok":true` and your configured printer share
name. In Charlie itself, Settings → Receipt Printers will show a "Local
Print Relay" status alongside the existing USB printer status.

## Troubleshooting

- **"copy to printer share failed"** — double check the share name in
  `config.json` exactly matches Windows' Sharing tab (case doesn't matter,
  but spelling does), and that the printer is actually shared and online.
- **Nothing happens when printing from Charlie** — make sure
  `start-relay.bat` is running (check for its window/taskbar icon), and that
  no firewall is blocking `127.0.0.1:9123` (it's localhost-only traffic, so
  this is rare, but some strict corporate firewalls do block loopback ports).
