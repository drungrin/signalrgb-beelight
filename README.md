# signalrgb-beelight

A SignalRGB add-on that drives a **Beelight V3 / AT32** addressable LED strip
(`2E3C:5740`) over its USB serial port.

The strip has no SignalRGB support of its own: Windows enumerates it as a plain
CDC device (`usbser`, a single `COM` port) and SignalRGB ignores it. This add-on
speaks the strip's own protocol directly, so the whole strip joins the canvas
like any other device — no bridge, no helper service, no second machine.

## What it does

- Reads the pixel count from the strip during the handshake, so the canvas shows
  the LEDs the hardware actually reports rather than a hard-coded number.
- Puts the controller into PC mode and streams one frame per LED at 30 fps.
- Answers the controller's heartbeats, and ignores the checksum-valid decoy
  frames it emits while idle.
- Reconnects on its own when the strip is unplugged and plugged back in.

## Installing

In SignalRGB, open **Settings → Add-ons**, choose **Add add-on**, and paste:

```text
https://github.com/drungrin/signalrgb-beelight
```

Restart SignalRGB. The strip appears as **Beelight V3** and can be positioned on
the canvas.

Do not copy `beelight.js` into SignalRGB's `Plugins` folder: that folder is
scanned for HID devices only, and a serial plugin placed there never loads.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Lighting Mode | `Canvas` | `Forced` overrides the effect with one colour |
| Forced Color | `#009bde` | The colour used in `Forced` mode |
| Shutdown Color | `#000000` | Written to the strip when SignalRGB exits |

The strip's own brightness is set to 100 during the handshake and left there.
SignalRGB already scales the canvas by its global and per-device brightness, so
a second control here would only quantise the same colours twice.

## Protocol

Frames are obfuscated rather than encrypted: a random key travels in the clear
inside every frame.

```text
55 AA 5A | payload_len(2 LE) | checksum(1) | marker(1) | key(key_size) | ciphertext
marker    = 0x30 + (key_size XOR 1)        key_size 3..10, default 5
checksum  = sum(marker + key + ciphertext) AND 0xFF
plaintext = attribute, command, ...data    XOR key, repeating
```

Commands are `0` heartbeat, `1` firmware, `3` sync-config and `5` control.
Control data is `control | 0xFF | inner_len(2 LE) | inner_data`, where the
control byte is `1` switch, `2` brightness, `4` colour, `5` RGB transfer and
`6` work mode.

The handshake runs in this order, each step waiting for its acknowledgement:
firmware, sync-config (which reports the pixel count), work mode, switch on,
brightness. After that, every rendered frame is a single RGB transfer, sent
without acknowledgement.

Acknowledgements carry no sequence number, and any control acknowledgement
satisfies any control request, so the plugin drains the port before each
acknowledged write. Without that, a late acknowledgement for the previous
command would satisfy the next one and a step could be skipped silently.

## Known limitations

- **SignalRGB holds the serial port exclusively** while it runs. Nothing else
  can drive the strip at the same time.
- The strip's onboard effect is not restored on shutdown. PC mode stays set and
  the strip goes to the configured shutdown colour.

## Development

The canonical source, the test harness and the cross-language test suite live in
the [`headless-rgb`](https://github.com/drungrin/headless-rgb) repository, under
`signalrgb/` and `tests/`. The tests run this plugin under Node against a fake
serial port and decode every byte it writes with that project's independent
Python implementation of the same protocol, so the two cannot drift apart.

Edit the plugin there, not here, and publish with:

```bash
python tools/sync_addon.py beelight ../signalrgb-beelight
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
