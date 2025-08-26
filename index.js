// Yellowstone Example.
//
// Connects to the specified RTSP server url,
// Once connected, opens a file and streams H264 and AAC to the files
//
// Yellowstone is written in TypeScript. This example uses Javascript and
// the typescript compiled files in the ./dist folder
//
//
// Note on RTSPS (TLS) connection
// Test Bosch IP Camera with "RTSPS" will stream "rtp over rtsp" in a Secure RTSPS connection
// Text Axis IP Camera with "RTSPS" wants to encrypt the RTP packets (SRTP) which this library does not currently support and uses RTP/SAVP instead of RTP/AVP

// Used to connect to Wowza Demo URL but they have taken it away, and the replacement URL on their web site does not work.

import { RTSPClient } from "yellowstone";
import fs from "fs";
import { program } from "commander";

import H264Transport from "./H264Transport.js";
import H265Transport from "./H265Transport.js";
import AACTransport from "./AACTransport.js";
import TransportStreamPacketizer from "./TransportStreamPacketizer.js";

program.name("demo");
program.description("Yellowstone RTSP Client Test Software");
program.option("-u, --username <value>", "Optional RTSP Username");
program.option("-p, --password <value>", "Optional RTSP Password");
program.option(
	"-o, --outfile <value>",
	"Optional Output File with no File Extension for captured H264/H265/AAC",
);

program.argument("<rtsp url eg rtsp://1.2.3.4/stream1>");

program.parse(process.argv);
const options = program.opts();

// Will automatically exit if the Argument (the RTSL URL) is missing
const url = program.args[0];
let username = "";
let password = "";
if ("username" in options) username = options.username;
if ("password" in options) password = options.password;

const filename = "outfile";

console.log("Connecting to " + url);

// Step 1: Create an RTSPClient instance
const client = new RTSPClient(username, password);

// Step 2: Connect to a specified URL using the client instance.
//
// "keepAlive" option is set to true by default
// "connection" option is set to "udp" by default and defines the method the RTP media packets are set to Yellowstone. Options are "udp" or "tcp" (where RTP media packets are sent down the RTSP connection)
// "secure" option is set to true when connecting with TLS to the RTSP Server (eg for RTSPS)
client
	.connect(url, { connection: "tcp", secure: false })
	.then(async detailsArray => {
		console.log("Connected");

		if (detailsArray.length == 0) {
			console.log("ERROR: There are no compatible RTP payloads to save to disk");
			process.exit();
		}

		let video = null;
		let videoCodec = null;
		let audio = null;
		let audioCodec = null;

		for (let x = 0; x < detailsArray.length; x++) {
			let details = detailsArray[x];
			console.log(`Stream ${x}. Codec is`, details.codec);

			if (details.codec == "H264") {
				video = new H264Transport(client, details);
				videoCodec = "H264";
			}
			if (details.codec == "H265") {
				video = new H265Transport(client, details);
				videoCodec = "H265";
			}
			if (details.codec == "AAC") {
				audio = new AACTransport(client, details);
				audioCodec = "AAC";
			}
		}

		if (video == null) {
			console.log("ERROR: No supported video stream found");
		}

		const outputFile = fs.createWriteStream(filename + ".ts");
		const packetizerOptions = {
			stream: outputFile,
			videoCodec: "H264",
			sps: video.sps,
			spp: video.spp,
		};

		const transportStreamPacketizer = new TransportStreamPacketizer(packetizerOptions);
		video.on("data", (frame, timestamp) => {
			transportStreamPacketizer.writeVideoSample(frame, timestamp, true);
		});
		if (audio) {
			audio.on("data", (frame, timestamp) => {
				transportStreamPacketizer.writeAudioSample(frame, timestamp);
			});
		}

		// Step 5: Start streaming!
		await client.play();
		console.log("Play sent");
	})
	.catch(e => {
		console.log(e);
		client.removeAllListeners();
		client.close(true); // true = don't send a TEARDOWN
	});

// The "data" event is fired for every RTP packet.
client.on("data", (channel, data, packet) => {
	console.log(
		"RTP:",
		"Channel=" + channel,
		"TYPE=" + packet.payloadType,
		"ID=" + packet.id,
		"TS=" + packet.timestamp,
		"M=" + packet.marker,
		packet.wallclockTime == undefined
			? "Time=Unknown"
			: "Time=" + packet.wallclockTime.toISOString(),
	);
});

// The "controlData" event is fired for every RTCP packet.
client.on("controlData", (channel, rtcpPacket) => {
	console.log("RTCP:", "Channel=" + channel, "PT=" + rtcpPacket.packetType);
});

// The "log" event allows you to optionally log any output from the library.
// You can hook this into your own logging system super easily.

client.on("log", (data, prefix) => {
	console.log(prefix + ": " + data);
});
