# Direct Windows Printing (no extra software)

The third — and now recommended default — way to get Charlie printing on a
till, alongside USB pairing (Zadig/WebUSB) and the Print Relay in this same
folder. This one needs **no background program running on the till at all**.

## Why this exists

Pairing a printer with Charlie via WebUSB (the Zadig fix) makes Windows hand
that printer *exclusively* to Charlie's browser tab — no other program on
that PC, including a fallback till system, can print to it anymore while
that pairing is active. The Print Relay was built to work around that by
routing through the printer's normal shared driver instead — but it's still
a second program that has to be installed, configured, and kept running.

Direct Windows Printing skips both problems at the source: it never touches
WebUSB or Zadig, so the printer is never exclusively claimed in the first
place. It prints the exact same way any other Windows program does —
through the printer's own normal driver — using the browser's own print
function. The only thing needed to make that silent (no print dialog
popping up on every single sale) instead of just a working fallback is one
flag added to the till's browser shortcut.

**If a printer on this till was ever set up for WebUSB pairing (Zadig) or
the Print Relay, and you're moving it to Direct Printing instead, undo that
first** — see "Undoing a previous WebUSB/Zadig pairing" below. A printer
already forced into raw WinUSB mode won't show up as a normal Windows
printer for Direct Printing to use until that's undone.

## One-time setup (per till)

### 1. Make sure the printer is installed normally

Control Panel → Devices and Printers. The receipt printer should be listed
there as a normal printer (its manufacturer's name, e.g. "EPSON TM-T88").

If it's **not** listed there, but shows up in Device Manager under
"Universal Serial Bus devices" instead — see "Undoing a previous
WebUSB/Zadig pairing" below first, then come back to this step.

If it's not listed anywhere, install the printer's normal manufacturer
driver (from the printer's box/website) the same way you'd install it for
any other Windows program.

### 2. Set it as the Windows default printer

Devices and Printers → right-click the receipt printer → **Set as default
printer**. This is what the browser prints to silently under
`--kiosk-printing` — it doesn't ask which printer, it just uses whichever
one Windows currently has set as default.

### 3. Add the `--kiosk-printing` flag to Charlie's shortcut

1. Right-click the desktop shortcut used to open Charlie on this till →
   **Properties**.
2. In the **Target** field, add a space and then `--kiosk-printing` at the
   very end. Example:
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://your-charlie-url/pos`
3. Click OK.
4. Close every open Chrome/Edge window on this till completely (check the
   taskbar/system tray — a lingering background process will ignore the
   flag on the next launch), then reopen Charlie from that shortcut.

If this till doesn't already have a dedicated shortcut for Charlie (it was
just being opened from a browser bookmark), create one: right-click the
desktop → New → Shortcut → paste the Target line above (with your actual
browser path and Charlie URL) → give it a name like "Charlie Till".

### 4. Turn it on in Charlie

In Charlie: **Settings → Receipt Printers → Direct Windows Printing** →
check "This till uses Direct Windows Printing".

### 5. Test it

Ring up any sale and complete it (or use the Sale Complete modal's Print
button on an existing sale). It should print silently, with no dialog. If a
print dialog still appears, step 3 didn't take — re-check the shortcut and
make sure all browser windows/processes were fully closed before reopening
from it.

## Known limitation: no automatic cash drawer

Direct Windows Printing does not open the cash drawer automatically after a
cash sale (USB pairing and the Print Relay both can, since they send the
drawer-kick command as raw bytes the printer understands directly — a
rendered browser print job doesn't reliably carry that through). The
cashier opens the drawer manually on this path. If auto-open is essential
for a specific till, use USB pairing or the Print Relay there instead.

## Undoing a previous WebUSB/Zadig pairing

Only needed if this printer was ever paired with Charlie via USB (below) or
went through Zadig for some other reason, and now needs to work as a normal
shared Windows printer again:

1. Device Manager → find the printer (it will show under **Universal
   Serial Bus devices** instead of **Printers** while the Zadig fix is
   active).
2. Right-click it → **Uninstall device**.
3. Unplug the printer, wait a few seconds, plug it back in. Windows should
   reinstall its normal driver automatically and it should now appear
   under Devices and Printers as a normal printer.
4. If it doesn't reinstall automatically, install the manufacturer's driver
   manually from the printer's box/website.

This is the same procedure described in this folder's `README.md` (Print
Relay setup, step 1) — it's the same underlying fix either way, just
followed here to get back to a normal printer for Direct Printing instead
of a shared one for the relay.
