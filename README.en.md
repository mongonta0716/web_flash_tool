# web_flash_tool

English | [日本語](README.md)

A web-based tool for flashing firmware to M5Stack devices (ESP32 / ESP32-S3)
through Tailscale using the browser's Web Serial API and `esptool-js`.

Select a `.bin` file from the `./firmware/` directory and flash it directly from
the browser over a serial connection. The entire flashing process runs in the
browser; the server only provides the firmware list and serves static files.

To specify a flash address and maximum capacity, append
`-0x<address>-<byte-count>bytes.bin` to the filename. For example,
`Stackchan_dance-m5stack-cores3-579568e-20260723-194334-0x10000-6553600bytes.bin`
is written at address `0x10000`, and an error is raised if the file exceeds the
partition capacity of `6553600` bytes. Files without this suffix are written at
address `0x0` without a partition-capacity check.

## Setup

```sh
npm install
npm run build   # Build web/ into dist/
```

## Configuring Firmware-Producing Repositories

For the refresh button (`↻`) in this web tool to collect build artifacts, each
PlatformIO repository under `~/MyGit` must output its post-build firmware to a
`.pio_build_firmware/` directory at the repository root.

Use `~/MyGit/Stackchan_dance/scripts/copy_firmware.py` as the reference
implementation. Place `scripts/copy_firmware.py` in each target repository:

```sh
cd ~/MyGit/<target-repository>
mkdir -p scripts
cp ../Stackchan_dance/scripts/copy_firmware.py scripts/copy_firmware.py
```

Then register it as a post script in the target repository's `platformio.ini`.
To use it in every environment, add it to the shared `[env]` section:

```ini
[env]
extra_scripts =
    post:scripts/copy_firmware.py
```

If `extra_scripts` is already defined, retain the existing entries and append
the following line to the same list:

```ini
    post:scripts/copy_firmware.py
```

After a normal PlatformIO build, `copy_firmware.py` combines the application,
filesystem, and additional images such as the bootloader and partition table
into a single binary matching the configured flash size. It copies the result
to `.pio_build_firmware/` using this filename format:

```text
<repository>-<environment>-<Git-hash>-<timestamp>-0x0-<flash-size>bytes.bin
```

For example, the `m5stack-cores3` environment in `Stackchan_dance` produces a
filename similar to:

```text
Stackchan_dance-m5stack-cores3-579568e-20260723-194334-0x0-16777216bytes.bin
```

The web tool uses the `0x0` address and flash capacity encoded in the filename
to determine the destination address and validate the file size. When `↻` is
clicked, `move_firmware.py` searches every repository for
`.pio_build_firmware/` directories and moves the generated binaries into this
web tool's `firmware/` directory.

The script relies on ESP32 PlatformIO environment values such as
`ESP32_APP_OFFSET`, `FS_START`, `ESP32_FS_IMAGE_NAME`, and
`FLASH_EXTRA_IMAGES`. Adjust `copy_firmware.py` for projects that do not use a
filesystem or whose variables and image layout differ.

## Running

```sh
npm start        # Serve dist/ and the API at http://localhost:3000
```

For development with frontend hot reload:

```sh
npm run dev       # API on 3001 and Vite development server on 5173
```

## Web Serial and HTTPS over Tailscale

The Web Serial API is available only in a secure context: HTTPS or `localhost`.
HTTPS is therefore required when accessing the tool through Tailscale using a
`*.ts.net` hostname.

Tailscale's certificate feature provides a convenient way to enable HTTPS.
Generate the certificate and key under `.secret/`. This directory is excluded
by `.gitignore` and must not be committed.

```sh
# First enable HTTPS certificates in the Tailscale admin console
cd .secret
tailscale cert --cert-file=<device>.<tailnet>.ts.net.crt --key-file=<device>.<tailnet>.ts.net.key <device>.<tailnet>.ts.net
```

Running `./web_start.sh` detects the hostname from `tailscale status --json`,
loads `.secret/<device>.<tailnet>.ts.net.{key,crt}`, and starts the server.

```sh
./web_start.sh
```

You can override the hostname-derived certificate paths and port with
environment variables:

```sh
TLS_KEY_PATH=.secret/<device>.<tailnet>.ts.net.key \
TLS_CERT_PATH=.secret/<device>.<tailnet>.ts.net.crt \
PORT=8443 \
npm start
```

Open `https://<device>.<tailnet>.ts.net:8443` in the browser. When
`TLS_KEY_PATH` and `TLS_CERT_PATH` are not provided, the server uses HTTP;
Web Serial will then work only when accessing it through local `localhost`.

Tailscale certificates are valid for approximately 90 days. Run the same
certificate command again to renew an expired certificate.

## Usage

1. **Connect a device**: Select the baud rate, click `Connect`, and choose the
   M5Stack serial port in the browser dialog. The tool automatically detects
   the chip. If it does not match the chip expected by the selected `Board`,
   the tool asks for confirmation before continuing.
2. **Select firmware**: Select a `.bin` file from `./firmware/`. Clicking `↻`
   runs `python3 move_firmware.py ~/MyGit ./firmware` on the server and reloads
   the list. This collects new artifacts from `.pio_build_firmware/`
   directories under `~/MyGit`. Set `FIRMWARE_SOURCE_DIR` to use a different
   source directory. Select the target device—M5Stack Core2, M5Stack CoreS3,
   AtomS3, AtomS3R, or another configured board—from `Board`; its flash size is
   passed to the flashing operation.
3. **Flash**: Enable `Erase flash before write` when needed, then click `Flash`.
   The device resets automatically after a successful write.
4. **Serial Monitor**: Select the baud rate and click `Monitor`. Enable
   `切断時に直前のデバイスへ自動再接続` to keep monitoring active after a USB
   disconnect and resume automatically when the same device returns. Click
   `Monitor Disconnect` to stop monitoring or cancel the reconnect wait.

## Supported Boards and Flash Sizes

| Board            | Chip     | Flash size |
| ---------------- | -------- | ---------- |
| M5Stack Core2    | ESP32    | 16MB       |
| M5Stack CoreS3   | ESP32-S3 | 16MB       |
| AtomS3           | ESP32-S3 | 8MB        |
| AtomS3R          | ESP32-S3 | 8MB        |
| M5Stack Nesso N1 | ESP32-C6 | 16MB       |

This list is maintained in [`web/src/boards.json`](web/src/boards.json). Edit
that file and run `npm run build` (or `npm run dev`) to add or change a board.
Each entry's `value` is an internal identifier used by the flashing interface,
while `chip` is compared with the chip detected during connection.

## Notes

- Supported browsers: Chrome or Edge with Web Serial API support (version 89
  or later).
- The contents of `firmware/` are excluded from Git by `.gitignore`.
- Each `Flash` operation writes one file. When the firmware is split into a
  bootloader, partition table, application, filesystem, or other partitions,
  add the correct address suffix (`-0x<address>-<byte-count>bytes.bin`) to each
  file and flash the required files one at a time in the appropriate order.

## Acknowledgements

This tool was developed with reference to ciniml's
[stackchan-idf](https://github.com/ciniml/stackchan-idf). Many thanks to
ciniml for making this excellent project publicly available.

## License

This project is released under the [Boost Software License 1.0](LICENSE).
