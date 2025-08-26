import transform from "sdp-transform";
import { EventEmitter } from "events";
// .h265 file header
const H265_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x01]);
export default class H265Transport extends EventEmitter {
	constructor(client, details) {
		this.has_donl = false;
		this.rtpPackets = [];
		this.vps = null;
		this.sps = null;
		this.pps = null;
		this.client = client;
		// process 'fmtp' (which is optional in the SDP)
		this.processConnectionDetails(details);
		client.on("data", (channel, data, packet) => {
			if (channel == details.rtpChannel) {
				this.processRTPPacket(packet);
			}
		});
	}
	processConnectionDetails(details) {
		// Extract the VPS, SPS and PPS from the MediaSource part of the SDP.
		// NOTE the H265 RTP standard makes this optional and we may need to extract this from the RTP payload
		// as inband VPS/SPS/PPS instead
		const fmtp = details.mediaSource.fmtp[0];
		if (!fmtp) {
			return;
		}
		const fmtpConfig = transform.parseParams(fmtp.config);
		this.vps = Buffer.from(fmtpConfig["sprop-vps"].toString(), "base64");
		this.sps = Buffer.from(fmtpConfig["sprop-sps"].toString(), "base64");
		this.pps = Buffer.from(fmtpConfig["sprop-pps"].toString(), "base64");
	}
	processRTPPacket(packet) {
		// Accumatate RTP packets
		this.rtpPackets.push(packet.payload);
		// When Marker is set to 1 pass the group of packets to processRTPFrame()
		if (packet.marker == 1) {
			this.processRTPFrame(this.rtpPackets);
			this.rtpPackets = [];
		}
	}
	processRTPFrame(rtpPackets) {
		const nals = [];
		let partialNal = [];
		for (let i = 0; i < rtpPackets.length; i++) {
			// Examine the first two bytes of the RTP data, the Payload Header
			// F (Forbidden Bit),
			// Type of NAL Unit (or VCL NAL Unit if Type is < 32),
			// LayerId
			// TID  (TemporalID = TID - 1)
			/*+---------------+---------------+
			 *|0|1|2|3|4|5|6|7|0|1|2|3|4|5|6|7|
			 *+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
			 *|F|   Type    |  LayerId  | TID |
			 *+-------------+-----------------+
			 */
			const packet = rtpPackets[i];
			const payload_header = (packet[0] << 8) | packet[1];
			const payload_header_f_bit = (payload_header >> 15) & 0x01;
			const payload_header_type = (payload_header >> 9) & 0x3f;
			const payload_header_layer_id = (payload_header >> 3) & 0x3f;
			const payload_header_tid = payload_header & 0x7;
			// There are three ways to Packetize NAL units into RTP Packets
			//  Single NAL Unit Packet
			//  Aggregation Packet (payload_header_type = 48)
			//  Fragmentation Unit (payload_header_type = 49)
			// Single NAL Unit Packet
			// 32=VPS
			// 33=SPS
			// 34=PPS
			if (payload_header_type != 48 && payload_header_type != 49) {
				//TODO - Handle DONL
				nals.push(packet);
			}
			// Aggregation Packet
			else if (payload_header_type == 48) {
				// TODO
				console.log("eek");
			}
			// Fragmentation Unit
			else if (payload_header_type == 49) {
				//Console.WriteLine("Fragmentation Unit");
				//    0 1 2 3 4 5 6 7
				//   +-+-+-+-+-+-+-+-+
				//   |S|E|  FuType   |
				//   +---------------+
				//
				// Parse Fragmentation Unit Header
				const fu_header_s = (packet[2] >> 7) & 0x01; // start marker
				const fu_header_e = (packet[2] >> 6) & 0x01; // end marker
				const fu_header_type = (packet[2] >> 0) & 0x3f; // fu type
				// Console.WriteLine("Frag FU-A s=" + fu_header_s + "e=" + fu_header_e);
				// Check Start and End flags
				if (fu_header_s == 1 && fu_header_e == 0) {
					// Start Fragment.
					// Initiise the partialNal byte array
					// Empty the partial NAL array
					partialNal = [];
					// Reconstrut the NAL header from the rtp_payload_header, replacing the Type with FU Type
					let nal_header = payload_header & 0x81ff; // strip out existing 'type'
					nal_header = nal_header | (fu_header_type << 9);
					partialNal.push((nal_header >> 8) & 0xff);
					partialNal.push((nal_header >> 0) & 0xff);
				}
				// Copy the video data
				if (this.has_donl) {
					// start copying after the DONL data
					for (let x = 5; x < packet.length; x++) {
						partialNal.push(packet[x]); // not very efficient, copying one byte at a time
					}
				} else {
					// there is no DONL data
					for (let x = 3; x < packet.length; x++) {
						partialNal.push(packet[x]); // not very efficient, copying one byte at a time
					}
				}
				if (fu_header_s == 0 && fu_header_e == 1) {
					// End Fragment
					// Append this payload to the fragmented_nal
					// Add the NAL to the array of NAL units
					nals.push(Buffer.from(partialNal));
				}
			} else {
				//Console.WriteLine("Unknown Payload Header Type = " + payload_header_type);
			}
		}
		// Write out all the NALs
		for (let x = 0; x < nals.length; x++) {
			this.emit("data", Buffer.concat([H265_HEADER, nals[x]]), this.lastTimestamp);
		}

		this.lastTimestamp = null;
	}
}
