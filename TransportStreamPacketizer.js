import { Writable } from "stream";
import { checksum } from "./crc32.js";

const SYNC_BYTE = 0x47;
const PACKET_SIZE = 188;
const MAX_AUDIO_SAMPLES_PACK = 5;

const PAT_PID = 0x0;
const PMP_PID = 0xfff;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

const STREAM_TYPES = {
	AAC: 0x0f,
	H264: 0x1b,
	H265: 0x24,
};

export default class TransportStreamPacketizer {
	constructor({ stream, videoCodec, sps, pps, audioCodec, timescale = 90000 }) {
		if (!(stream instanceof Writable)) throw new Error("stream must be a Writable stream");

		this.stream = stream;
		this.timescale = timescale;

		this.audioCodec = audioCodec;

		/*this._audioCodecInfo = audioCodec
      ? CodecParser.parse(audioExtraData)
      : null;*/

		this.videoCodec = videoCodec;
		this.sps = sps;
		this.pps = pps;

		this._videoConfig = this.sps || this.pps ? this._buildVideoConfig() : Buffer.alloc(0);

		this._wroteHeader = false;

		this._audioPackets = [];
		this._audioPacketsLength = 0;
		this._audioPacketsSample = null;
		this._audioPacketsTime = 0;

		this._counter = {};
	}

	writeVideoSample(buffer, timestamp, isKeyframe) {
		if (!this._wroteHeader) this._writeHeader();

		if (this._audioPackets.length > 0) this._flushAudio();

		const dtsTime = ((this.timescale * timestamp) / this.timescale) << 0;
		const ptsTime = dtsTime; // assume no composition offset

		const packet = this._convertVideoSample(buffer, isKeyframe);
		const videoBuffer = this._packVideoPayload(packet, dtsTime, ptsTime, isKeyframe);
		this.stream.write(videoBuffer);
	}

	writeAudioSample(buffer, timestamp) {
		if (!this._wroteHeader) this._writeHeader();

		const dtsTime = ((this.timescale * timestamp) / this.timescale) << 0;
		//const packet = this._convertAudioSample(buffer);
		const packet = buffer;

		if (this._audioPackets.length === 0) {
			this._audioPacketsSample = {}; // dummy object
			this._audioPacketsTime = dtsTime;
		}

		this._audioPackets.push(packet);
		this._audioPacketsLength += packet.length;

		if (this._audioPackets.length >= MAX_AUDIO_SAMPLES_PACK) {
			this._flushAudio();
		}
	}

	end() {
		if (this._audioPackets.length > 0) {
			this._flushAudio();
		}
	}

	_flushAudio() {
		const payload = Buffer.concat(this._audioPackets, this._audioPacketsLength);
		const buffer = this._packAudioPayload(payload, this._audioPacketsTime);
		this.stream.write(buffer);

		this._audioPackets = [];
		this._audioPacketsLength = 0;
		this._audioPacketsSample = null;
		this._audioPacketsTime = 0;
	}

	_writeHeader() {
		this.stream.write(this._buildHeader());
		this._wroteHeader = true;
	}

	// This adds the adts header to the AAC data, but it already comes wrapped so we can skip this
	/*_convertAudioSample(buffer) {
    const header = Buffer.allocUnsafe(7);
    const config = this._audioCodecInfo;

    const frameLength = buffer.length + 7;

    header[0] = 0xff;
    header[1] = 0xf1;
    header[2] = ((config.profileObjectType - 1) << 6) | (config.rateIndex << 2) | (config.channelsIndex >> 2);
    header[3] = ((config.channelsIndex & 3) << 6) | ((frameLength >> 11) & 0x03);
    header[4] = (frameLength >> 3) & 0xff;
    header[5] = ((frameLength & 7) << 5) | 0x1f;
    header[6] = 0xfc;

    return Buffer.concat([header, buffer]);
  }*/

	_convertVideoSample(buffer, isKeyframe) {
		let prefixLen = 6 + (isKeyframe ? this._videoConfig.length : 0);
		if (this.videoCodec === "H265") prefixLen++;

		const packet = Buffer.allocUnsafe(prefixLen + buffer.length);
		let pos = 0;

		packet.writeUInt32BE(1, pos);
		pos += 4;

		if (this.videoCodec === "H265") {
			packet[pos++] = 70;
			packet[pos++] = 0x01;
		} else {
			packet[pos++] = 9;
		}

		packet[pos++] = 0x10;

		if (isKeyframe) {
			this._videoConfig.copy(packet, pos);
			pos += this._videoConfig.length;
		}

		buffer.copy(packet, pos);

		return packet;
	}

	_packAudioPayload(payload, dtsTime) {
		const pesHeader = Buffer.allocUnsafe(14);
		let pos = 0;

		pesHeader.writeUIntBE(0x000001c0, pos, 4);
		pos += 4;
		pesHeader.writeUInt16BE(payload.length + 8, pos);
		pos += 2;
		pesHeader[pos++] = 0x80; // marker bits
		pesHeader[pos++] = 0x80; // PTS only
		pesHeader[pos++] = 5;

		pos += this._writeTime(pesHeader, pos, dtsTime, 0x20);

		const fullPayload = Buffer.concat([pesHeader, payload]);
		return this._packPayload(fullPayload, AUDIO_PID, dtsTime, false);
	}

	_packVideoPayload(payload, dtsTime, ptsTime, isKeyframe) {
		const pesHeader = Buffer.allocUnsafe(19);
		let pos = 0;

		pesHeader.writeUIntBE(0x000001e0, pos, 4);
		pos += 4;
		pesHeader.writeUInt16BE(0x0000, pos);
		pos += 2; // will be ignored
		pesHeader[pos++] = 0x80;
		pesHeader[pos++] = 0xc0; // PTS and DTS
		pesHeader[pos++] = 10;

		pos += this._writeTime(pesHeader, pos, ptsTime, 0x30);
		pos += this._writeTime(pesHeader, pos, dtsTime, 0x10);

		const fullPayload = Buffer.concat([pesHeader, payload]);
		return this._packPayload(fullPayload, VIDEO_PID, dtsTime, isKeyframe);
	}

	_packPayload(payload, pid, dtsTime, isKeyframe) {
		const packets = [];
		const numPackets = Math.ceil(payload.length / (PACKET_SIZE - 4));
		let payloadPos = 0;

		for (let i = 0; i < numPackets; i++) {
			const packet = Buffer.alloc(PACKET_SIZE);
			let pos = 0;

			packet[pos++] = SYNC_BYTE;
			packet[pos++] = (i === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f);
			packet[pos++] = pid & 0xff;
			packet[pos++] = this._counterNext(pid) | 0x10;

			const remaining = payload.length - payloadPos;
			const capacity = PACKET_SIZE - pos;

			const toCopy = Math.min(remaining, capacity);
			payload.copy(packet, pos, payloadPos, payloadPos + toCopy);
			payloadPos += toCopy;

			packets.push(packet);
		}

		return Buffer.concat(packets);
	}

	_counterNext(pid) {
		if (this._counter[pid] == null) {
			this._counter[pid] = 0;
			return 0;
		}
		this._counter[pid] = (this._counter[pid] + 1) & 0xf;
		return this._counter[pid];
	}

	_buildHeader() {
		const buffer = Buffer.allocUnsafe(PACKET_SIZE * 2);
		let pos = 0;

		// PAT
		pos = this._writePAT(buffer, pos);

		// PMT
		pos = this._writePMT(buffer, pos);

		buffer.fill(0xff, pos); // padding

		return buffer;
	}

	_writePAT(buffer, pos) {
		buffer[pos++] = SYNC_BYTE;
		buffer[pos++] = 0x40 | ((PAT_PID >> 8) & 0x1f);
		buffer[pos++] = PAT_PID & 0xff;
		buffer[pos++] = 0x10;
		buffer[pos++] = 0x00;

		const sectionStart = pos;

		buffer[pos++] = 0x00;
		buffer[pos++] = 0xb0 | ((13 >> 8) & 0x0f);
		buffer[pos++] = 13 & 0xff;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x01;
		buffer[pos++] = 0xc1;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x01;
		buffer[pos++] = 0xe0 | ((PMP_PID >> 8) & 0x1f);
		buffer[pos++] = PMP_PID & 0xff;

		const crc = checksum(buffer, sectionStart, pos);
		buffer.writeUInt32BE(crc, pos);
		pos += 4;

		return pos;
	}

	_writePMT(buffer, pos) {
		buffer[pos++] = SYNC_BYTE;
		buffer[pos++] = 0x40 | ((PMP_PID >> 8) & 0x1f);
		buffer[pos++] = PMP_PID & 0xff;
		buffer[pos++] = 0x10;
		buffer[pos++] = 0x00;

		const sectionStart = pos;
		let sectionLength = 13;
		let streamCount = 0;

		if (this.videoCodec) {
			sectionLength += 5;
			streamCount++;
		}
		if (this.audioCodec) {
			sectionLength += 5;
			streamCount++;
		}

		buffer[pos++] = 0x02;
		buffer[pos++] = 0xb0 | ((sectionLength >> 8) & 0x0f);
		buffer[pos++] = sectionLength & 0xff;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x01;
		buffer[pos++] = 0xc1;
		buffer[pos++] = 0x00;
		buffer[pos++] = 0x00;

		buffer[pos++] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f);
		buffer[pos++] = VIDEO_PID & 0xff;
		buffer[pos++] = 0xf0;
		buffer[pos++] = 0x00;

		if (this.videoCodec) {
			buffer[pos++] = STREAM_TYPES[this.videoCodec] || 0;
			pos += this._writePid(buffer, pos, VIDEO_PID);
		}

		if (this.audioCodec) {
			buffer[pos++] = STREAM_TYPES[this.audioCodec] || 0;
			pos += this._writePid(buffer, pos, AUDIO_PID);
		}

		const crc = checksum(buffer, sectionStart, pos);
		buffer.writeUInt32BE(crc, pos);
		pos += 4;

		return pos;
	}

	_writeTime(buffer, pos, time, base) {
		buffer[pos++] = base | (((time >> 30) & 0x07) << 1) | 1;
		buffer[pos++] = (time >> 22) & 0xff;
		buffer[pos++] = (((time >> 15) & 0x7f) << 1) | 1;
		buffer[pos++] = (time >> 7) & 0xff;
		buffer[pos++] = ((time & 0x7f) << 1) | 1;
		return 5;
	}

	_writePid(buffer, pos, pid) {
		buffer[pos++] = 0xe0 | ((pid >> 8) & 0x1f);
		buffer[pos++] = pid & 0xff;
		buffer[pos++] = 0xf0;
		buffer[pos++] = 0x00;
		return 4;
	}

	_buildVideoConfig() {
		const units = [this.sps, this.pps].filter(u => u != null);
		const size = units.reduce((sum, unit) => sum + 4 + unit.length, 0);
		const data = Buffer.allocUnsafe(size);

		let pos = 0;
		for (const unit of units) {
			data.writeUInt32BE(1, pos);
			pos += 4;
			unit.copy(data, pos);
			pos += unit.length;
		}

		return data;
	}
}
