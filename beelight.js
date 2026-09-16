// SPDX-License-Identifier: GPL-3.0-or-later
//
// canonical: headless-rgb signalrgb/beelight-v3.js
//
// Beelight V3 / AT32 LED strip, driven directly from SignalRGB over its USB
// CDC serial port. The strip is plugged into the Windows PC, so there is no
// tunnel and no second machine: SignalRGB talks to the hardware itself.
//
// The wire protocol is ported from src/headless_lights/beelight/protocol.py in
// the headless-rgb repository, which was reverse engineered from captures of
// the vendor tool. tests/test_beelight_plugin_frames.py decodes the frames this
// file produces with that same Python parser, so the two cannot drift apart.

import Serial from "@SignalRGB/serial";

export function Name() { return "Beelight V3"; }
export function Version() { return "1.0.0"; }
export function Type() { return "serial"; }
export function Publisher() { return "headless-lights"; }
export function VendorId() { return 0x2e3c; }
export function ProductId() { return 0x5740; }
// Not "ledstrip": SignalRGB rejects it. DiscoverableDevice::StringToType
// accepts only keyboard, mouse, gpu, dongle, motherboard, lightingcontroller,
// headphones, lcd, wifi, microphone, aio, ram, case, speakers, mousepad and
// other, and an unknown value kills the plugin before Initialize() runs.
export function DeviceType() { return "lightingcontroller"; }
export function Size() { return [DEFAULT_LED_COUNT, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 4.0; }

// Deliberately no Validate(). The strip is a single-function CDC device: its
// instance path carries no &MI_xx, so there is no interface number to select.
// The composite-CDC plugins that ship with SignalRGB need one; Hyte and the OEM
// controller, which are single-function like this, omit it.

/* global
device:readonly
LightingMode:readonly
forcedColor:readonly
shutdownColor:readonly
*/

export function ControllableParameters() {
	return [
		{
			property: "LightingMode",
			group: "lighting",
			label: "Lighting Mode",
			type: "combobox",
			values: ["Canvas", "Forced"],
			default: "Canvas",
		},
		{
			property: "forcedColor",
			group: "lighting",
			label: "Forced Color",
			min: "0",
			max: "360",
			type: "color",
			default: "#009bde",
		},
		{
			property: "shutdownColor",
			group: "lighting",
			label: "Shutdown Color",
			min: "0",
			max: "360",
			type: "color",
			default: "#000000",
		},
	];
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const HEADER = [0x55, 0xaa, 0x5a];
const MIN_KEY_SIZE = 3;
const MAX_KEY_SIZE = 10;
const DEFAULT_KEY_SIZE = 5;

const COMMAND_HEARTBEAT = 0;
const COMMAND_FIRMWARE = 1;
const COMMAND_SYNC_CONFIG = 3;
const COMMAND_CONTROL = 5;

const CONTROL_SWITCH = 1;
const CONTROL_BRIGHTNESS = 2;
const CONTROL_COLOR = 4;
const CONTROL_RGB_TRANSFER = 5;
const CONTROL_WORK_MODE = 6;

const ATTRIBUTE_REQUEST = 0;
const ATTRIBUTE_ACKNOWLEDGEMENT = 1;

const DEFAULT_LED_COUNT = 33;
const MAX_LED_COUNT = 4096;

function randomKey(keySize) {
	const key = new Array(keySize);
	for (let index = 0; index < keySize; index++) {
		// Obfuscation, not encryption: the key travels in the clear inside the
		// frame. Math.random is the right tool and is always available here.
		key[index] = Math.floor(Math.random() * 256) & 0xff;
	}
	return key;
}

function encodeFrame(command, data, options) {
	const settings = options || {};
	const attribute = settings.attribute === undefined
		? ATTRIBUTE_REQUEST
		: settings.attribute;
	const keySize = settings.keySize === undefined ? DEFAULT_KEY_SIZE : settings.keySize;
	const key = settings.key || randomKey(keySize);
	const payloadData = data || [];

	const plaintext = [attribute, command].concat(Array.from(payloadData));
	const ciphertext = new Array(plaintext.length);
	for (let index = 0; index < plaintext.length; index++) {
		ciphertext[index] = plaintext[index] ^ key[index % key.length];
	}

	const marker = 0x30 + (key.length ^ 1);
	const body = [marker].concat(key, ciphertext);
	let checksum = 0;
	for (let index = 0; index < body.length; index++) {
		checksum = (checksum + body[index]) & 0xff;
	}

	const payload = [checksum].concat(body);
	return HEADER.concat([payload.length & 0xff, (payload.length >> 8) & 0xff], payload);
}

// Returns null rather than throwing. The controller emits checksum-valid decoy
// frames while idle, so a rejected frame is the common case, not an error — and
// an exception escaping into a SignalRGB engine thread gets the device
// quarantined across restarts.
function decodeFrame(raw) {
	if (raw.length < 5) {
		return null;
	}
	if (raw[0] !== HEADER[0] || raw[1] !== HEADER[1] || raw[2] !== HEADER[2]) {
		return null;
	}
	const payloadSize = raw[3] | (raw[4] << 8);
	if (raw.length !== 5 + payloadSize) {
		return null;
	}

	const payload = raw.slice(5);
	if (payload.length < 7) {
		return null;
	}
	let checksum = 0;
	for (let index = 1; index < payload.length; index++) {
		checksum = (checksum + payload[index]) & 0xff;
	}
	if (payload[0] !== checksum) {
		return null;
	}

	const keySize = (payload[1] - 0x30) ^ 1;
	if (keySize < MIN_KEY_SIZE || keySize > MAX_KEY_SIZE) {
		return null;
	}
	const ciphertextOffset = 2 + keySize;
	if (payload.length < ciphertextOffset + 2) {
		// A checksum-valid decoy: no command rides in it.
		return null;
	}

	const key = payload.slice(2, ciphertextOffset);
	const ciphertext = payload.slice(ciphertextOffset);
	const plaintext = new Array(ciphertext.length);
	for (let index = 0; index < ciphertext.length; index++) {
		plaintext[index] = ciphertext[index] ^ key[index % key.length];
	}
	if (plaintext[0] !== ATTRIBUTE_REQUEST && plaintext[0] !== ATTRIBUTE_ACKNOWLEDGEMENT) {
		return null;
	}

	return {
		attribute: plaintext[0],
		command: plaintext[1],
		data: plaintext.slice(2),
		keySize: keySize,
	};
}

// Splits arbitrary serial reads into complete frames, resynchronising on the
// header. Ported from protocol.py FrameStream, plus a buffer ceiling so a
// permanently corrupt stream cannot grow without bound inside a long-lived
// engine.
const MAX_BUFFER = 8192;

function FrameStream() {
	this.buffer = [];
}

FrameStream.prototype.reset = function () {
	this.buffer = [];
};

FrameStream.prototype.indexOfHeader = function () {
	for (let index = 0; index + 2 < this.buffer.length; index++) {
		if (
			this.buffer[index] === HEADER[0] &&
			this.buffer[index + 1] === HEADER[1] &&
			this.buffer[index + 2] === HEADER[2]
		) {
			return index;
		}
	}
	return -1;
};

FrameStream.prototype.feed = function (data) {
	for (let index = 0; index < data.length; index++) {
		this.buffer.push(data[index] & 0xff);
	}
	if (this.buffer.length > MAX_BUFFER) {
		this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER);
	}

	const frames = [];
	for (;;) {
		const headerAt = this.indexOfHeader();
		if (headerAt < 0) {
			// Keep the last two bytes: they may be the start of a header split
			// across two reads.
			if (this.buffer.length > HEADER.length - 1) {
				this.buffer = this.buffer.slice(this.buffer.length - (HEADER.length - 1));
			}
			break;
		}
		if (headerAt > 0) {
			this.buffer = this.buffer.slice(headerAt);
		}
		if (this.buffer.length < 5) {
			break;
		}

		const payloadSize = this.buffer[3] | (this.buffer[4] << 8);
		const totalSize = 5 + payloadSize;
		if (payloadSize > 65535) {
			this.buffer = this.buffer.slice(1);
			continue;
		}
		if (this.buffer.length < totalSize) {
			break;
		}
		frames.push(this.buffer.slice(0, totalSize));
		this.buffer = this.buffer.slice(totalSize);
	}
	return frames;
};

function controlData(control, payload, channel) {
	const target = channel === undefined ? 0xff : channel;
	return [control, target, payload.length & 0xff, (payload.length >> 8) & 0xff]
		.concat(Array.from(payload));
}

function controlFrame(control, payload) {
	return encodeFrame(COMMAND_CONTROL, controlData(control, payload));
}

function workModeFrame() { return controlFrame(CONTROL_WORK_MODE, [0, 0, 0]); }
function switchFrame(on) { return controlFrame(CONTROL_SWITCH, [on ? 1 : 0]); }
function brightnessFrame(value) {
	return controlFrame(CONTROL_BRIGHTNESS, [value & 0xff, (value >> 8) & 0xff]);
}
function heartbeatAck() {
	return encodeFrame(COMMAND_HEARTBEAT, [], { attribute: ATTRIBUTE_ACKNOWLEDGEMENT });
}

function pixelsFrame(colors) {
	const payload = [colors.length & 0xff, (colors.length >> 8) & 0xff];
	for (let index = 0; index < colors.length; index++) {
		const color = colors[index];
		payload.push(color[0] & 0xff, color[1] & 0xff, color[2] & 0xff);
	}
	return controlFrame(CONTROL_RGB_TRANSFER, payload);
}

function parseSyncConfig(data) {
	if (data.length < 3) {
		return null;
	}
	const totalPixels = data[0] | (data[1] << 8);
	// protocol.py trusts the device here. A truncated or corrupt acknowledgement
	// would otherwise produce a zero-LED or 65535-LED device on the canvas.
	if (totalPixels < 1 || totalPixels > MAX_LED_COUNT) {
		return null;
	}
	return { totalPixels: totalPixels, channelCount: data[2] };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const SERIAL_OPTIONS = {
	baudRate: 115200,
	dataBits: 8,
	parity: "None",
	stopBits: "One",
};

const READ_CHUNK = 1024;
// Never 0: a zero timeout is the value serial wrappers most often overload to
// mean "block forever", and that would freeze the engine thread.
const RENDER_READ_TIMEOUT_MS = 1;
const ACK_POLL_MS = 100;
const ACK_TIMEOUT_MS = 1500;
const ACK_ATTEMPTS = 3;
const SETTLE_MS = 250;
const RETRY_DELAY_MS = 2000;
const FRAME_INTERVAL_MS = 33;
const MAX_READS_PER_FRAME = 4;
// The strip's own brightness stays wide open. SignalRGB already scales
// device.color() by its global and per-device brightness, so a second
// multiplier here would just quantise the canvas twice.
const HARDWARE_BRIGHTNESS = 100;
const MAX_WRITE_FAILURES = 3;

const STATE_DISCONNECTED = "disconnected";
const STATE_READY = "ready";
const STATE_FAILED = "failed";

let state = STATE_DISCONNECTED;
let stream = new FrameStream();
let ledCount = DEFAULT_LED_COUNT;
let retryAt = 0;
let writeFailures = 0;
let frameRatePinned = false;
let lastSendAt = 0;
let streaming = false;

function now() { return Date.now(); }

// device.log() alone goes to the developer console only; the shipped plugins
// pass toFile for anything worth reading after the fact. Everything this plugin
// logs is a diagnostic, so all of it is worth writing down.
function log(message) {
	device.log("Beelight: " + message, { toFile: true });
}

function readBytes(timeoutMs) {
	const data = Serial.read(READ_CHUNK, timeoutMs);
	if (!data || data.length === 0) {
		return [];
	}
	return data;
}

// A discarded blocking read is the only sleep available in this sandbox, and it
// drains the port at the same time. Used for the post-open settle, which
// protocol-level timing needs because opening the CDC port toggles the control
// lines.
function settle(milliseconds) {
	readBytes(milliseconds);
	stream.reset();
}

function writeFrame(frame) {
	const ok = Serial.write(frame);
	if (ok === false) {
		writeFailures++;
		return false;
	}
	writeFailures = 0;
	return true;
}

function handleInbound(frame) {
	const decoded = decodeFrame(frame);
	if (decoded === null) {
		return null;
	}
	if (
		decoded.attribute === ATTRIBUTE_REQUEST &&
		decoded.command === COMMAND_HEARTBEAT
	) {
		Serial.write(heartbeatAck());
		return null;
	}
	return decoded;
}

// Mirrors BeelightDevice._exchange: poll in short slices until the deadline,
// answering heartbeats inline, and match on attribute + command.
function awaitAck(expectedCommand, timeoutMs) {
	const deadline = now() + timeoutMs;
	for (;;) {
		const remaining = deadline - now();
		if (remaining <= 0) {
			return null;
		}
		const data = readBytes(Math.min(ACK_POLL_MS, remaining));
		if (data.length === 0) {
			continue;
		}
		const frames = stream.feed(data);
		for (let index = 0; index < frames.length; index++) {
			const decoded = handleInbound(frames[index]);
			if (
				decoded !== null &&
				decoded.attribute === ATTRIBUTE_ACKNOWLEDGEMENT &&
				decoded.command === expectedCommand
			) {
				return decoded;
			}
		}
	}
}

// Control acknowledgements carry no sub-command, so a late acknowledgement for
// the previous control would satisfy this one — which would silently skip
// confirming the switch in a back-to-back WORK_MODE then SWITCH sequence.
// Dropping anything already in flight before writing makes the wait meaningful.
function requestWithAck(buildFrame, expectedCommand) {
	for (let attempt = 0; attempt < ACK_ATTEMPTS; attempt++) {
		readBytes(1);
		stream.reset();
		if (!writeFrame(buildFrame())) {
			return null;
		}
		const response = awaitAck(expectedCommand, ACK_TIMEOUT_MS);
		if (response !== null) {
			return response;
		}
	}
	return null;
}

function disconnect() {
	Serial.disconnect();
	state = STATE_DISCONNECTED;
	stream.reset();
}

function handshake() {
	if (Serial.isConnected()) {
		Serial.disconnect();
	}
	if (!Serial.connect(SERIAL_OPTIONS)) {
		log("serial connect failed");
		return false;
	}

	stream.reset();
	settle(SETTLE_MS);

	if (requestWithAck(function () { return encodeFrame(COMMAND_FIRMWARE, []); },
		COMMAND_FIRMWARE) === null) {
		log("no firmware response");
		return false;
	}

	const config = requestWithAck(
		function () { return encodeFrame(COMMAND_SYNC_CONFIG, []); },
		COMMAND_SYNC_CONFIG,
	);
	if (config === null) {
		log("no sync-config response");
		return false;
	}
	const parsed = parseSyncConfig(config.data);
	if (parsed === null) {
		log("unusable sync-config; keeping " + ledCount + " LEDs");
	} else {
		ledCount = parsed.totalPixels;
	}

	if (requestWithAck(workModeFrame, COMMAND_CONTROL) === null) {
		log("PC mode was not acknowledged");
		return false;
	}
	if (requestWithAck(function () { return switchFrame(true); }, COMMAND_CONTROL) === null) {
		log("switch-on was not acknowledged");
		return false;
	}
	// Best effort: the strip already lights without it, so a missed
	// acknowledgement here is not worth failing the whole handshake over.
	requestWithAck(
		function () { return brightnessFrame(HARDWARE_BRIGHTNESS); },
		COMMAND_CONTROL,
	);

	state = STATE_READY;
	log("ready on " + ledCount + " LEDs");
	return true;
}

function publishLeds() {
	const names = new Array(ledCount);
	const positions = new Array(ledCount);
	for (let index = 0; index < ledCount; index++) {
		names[index] = "LED " + (index + 1);
		positions[index] = [index, 0];
	}
	device.setSize([ledCount, 1]);
	device.setControllableLeds(names, positions);
}

function hexToRgb(hex) {
	const parsed = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (parsed === null) {
		return [0, 0, 0];
	}
	return [
		parseInt(parsed[1], 16),
		parseInt(parsed[2], 16),
		parseInt(parsed[3], 16),
	];
}

function readCanvas() {
	const colors = new Array(ledCount);
	const forced = LightingMode === "Forced" ? hexToRgb(forcedColor) : null;
	for (let index = 0; index < ledCount; index++) {
		if (forced !== null) {
			colors[index] = forced;
			continue;
		}
		const color = device.color(index, 0);
		colors[index] = [color[0], color[1], color[2]];
	}
	return colors;
}

// Drains the port and answers heartbeats. Runs before the pixel write so a
// heartbeat acknowledgement never queues behind a frame.
function pump() {
	for (let attempt = 0; attempt < MAX_READS_PER_FRAME; attempt++) {
		const data = readBytes(RENDER_READ_TIMEOUT_MS);
		if (data.length === 0) {
			return;
		}
		const frames = stream.feed(data);
		for (let index = 0; index < frames.length; index++) {
			handleInbound(frames[index]);
		}
	}
}

// ---------------------------------------------------------------------------
// SignalRGB lifecycle
// ---------------------------------------------------------------------------

export function Initialize() {
	state = STATE_DISCONNECTED;
	stream = new FrameStream();
	ledCount = DEFAULT_LED_COUNT;
	writeFailures = 0;
	frameRatePinned = false;
	lastSendAt = 0;
	streaming = false;

	device.setName("Beelight V3");
	device.setFrameRateTarget(30);
	log("Initialize() entered");

	const ok = handshake();
	// Publish the LEDs either way. A failed handshake should leave a device that
	// is dark and retrying, not one with zero LEDs that cannot be positioned.
	publishLeds();
	if (!ok) {
		state = STATE_FAILED;
		retryAt = now() + RETRY_DELAY_MS;
		log("handshake failed; retrying from Render()");
	}
	// Always true, even when the handshake failed. Reporting failure here makes
	// SignalRGB tear the device down, and the teardown closes the port out from
	// under the retry. Measured on the strip: the first handshake after opening
	// the port lost its PC-mode acknowledgement, the Render() retry completed
	// 2.8 s later, and the device was stopped anyway. None of the plugins that
	// ship with SignalRGB return false from Initialize(); they all recover in
	// Render(), and so does this one.
	return true;
}

export function Render() {
	if (state !== STATE_READY) {
		// One bounded retry per interval. Retrying inside every Render would
		// block the engine for several seconds per frame.
		if (now() >= retryAt) {
			retryAt = now() + RETRY_DELAY_MS;
			if (handshake()) {
				writeFailures = 0;
			}
		}
		return;
	}

	if (!Serial.isConnected()) {
		disconnect();
		retryAt = now() + RETRY_DELAY_MS;
		return;
	}

	pump();

	const elapsed = now() - lastSendAt;
	if (elapsed < FRAME_INTERVAL_MS) {
		return;
	}
	lastSendAt = now();

	writeFrame(pixelsFrame(readCanvas()));
	if (!streaming) {
		streaming = true;
		log("streaming " + ledCount + " LEDs");
	}

	if (writeFailures >= MAX_WRITE_FAILURES) {
		log("serial writes failing; reconnecting");
		disconnect();
		retryAt = now() + RETRY_DELAY_MS;
		return;
	}

	if (!frameRatePinned) {
		// The engine can reset the target after setup, so re-apply it once.
		device.setFrameRateTarget(30);
		frameRatePinned = true;
	}
}

export function Shutdown() {
	log("Shutdown(): releasing the port");
	if (state === STATE_READY) {
		const color = hexToRgb(shutdownColor);
		const colors = new Array(ledCount);
		for (let index = 0; index < ledCount; index++) {
			colors[index] = color;
		}
		// No acknowledgement exists for a pixel transfer, so send it twice
		// rather than hope a single fire-and-forget write survives.
		writeFrame(pixelsFrame(colors));
		writeFrame(pixelsFrame(colors));
	}
	// Release COM3. Unlike a network socket it is exclusive on Windows, and
	// holding it would block every other client.
	disconnect();
}

// Exposed for signalrgb/tests/dump_beelight_frames.mjs, which cross-checks this
// protocol port against the Python implementation. SignalRGB ignores it.
export const __testProtocol = {
	encodeFrame: encodeFrame,
	decodeFrame: decodeFrame,
	controlData: controlData,
	parseSyncConfig: parseSyncConfig,
	FrameStream: FrameStream,
};
