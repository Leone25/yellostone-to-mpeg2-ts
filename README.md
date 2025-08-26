# Yellowstone To MPEG2-TS converter

A demo script to convert RTSP streams into MPEG2-TS files in pure js



## Why?
Mainly, I was seraching for a way to save live camera feeds in a format that could be "done live", meaning that as the data came in, I could save it ASAP, hoping that in case of a crash/power falliture as much data as possible was saved. MP4 were not a good fit because they require knowing the length of a file beforehand, thus making the writing process a bit more complicated and delicate.

I then realized that HLS was the perfect format for my usecase because it saved video data constantly without the need to go back and edit, at least for the video feed. The playlist file (at least for livestreams) is not write once and forget, every time a new segment is created it has to be added to the playlist, but I was willing to accept having to implement a sort of "recovery mode" to fix the playlist file in case it was broken.

This also gave me an idea, since I'll have to save time based events along with the video, and the HLS spec already provides a way to do so, HLS really did turn out to be a great fit for this usecase.

So found my self needing to be able to generate the TS files without relying on other programs to do it for me (AKA I didn't want to use FFmpeg). There were plenty of project doing hls to mp4, but none I could find that did the opposite in a "streaming" way.

## How?
For fetching the streams, I already knew and worked with [Yellowsone](https://github.com/mbullington/yellowstone), a pure JS RTSP client implementation, and I knew it was able to extract raw H264/H265/AAC packets. The main issue with saving raw H264/H265 is that it rarely contains timing data, and rather relying on the container/transport format to provide it.

For the MPEG2-TS, I started originally by trying to read the ISO-IEC 13818-1 spec and writing my own parse/writer, but I quickly realized it was not as straight forward as I though, so I searched for alternative solutions.
I came across a couple of project, but they all were abandoned and not even half finished. Then I found [node-video-lib](https://github.com/gkozlenko/node-video-lib).

Node-video-lib showed a bit of hope, because it did provide a way to convert MP4 to HLS. The problem is that it expected a fully finished MP4 file to start with and there was no way to "stream data in".

After reading it's code a bit tho, I realized that the [PacketizerImpl class](https://github.com/gkozlenko/node-video-lib/blob/master/lib/hls/packetizer-impl.js) didn't really need to only work with finished MP4 files, and the main methods could be reused after some modifications to work like I wanted.

This is where this repo is born, it contains `TransportStreamPacketizer`, a modified PacketizerImpl class that can write to a stream and receive a stream of H264/H265 plus optional AAC audio. I decided to "extract" the class and make it work without the original library to make it more portable. I also needed to slightly modify the transport classes from Yellowstone to allow extracting the timestamp along with the frame, this allows me to reuse it to time correctly the frames in the TS file.

## What now?
Good luck IG and have fun!

This has been barely tested and has 0 error handling so it's definetly not production ready, plus the streams it generates are very bare bones, but FFplay plays it so I'm happy with that.

Next step would be splitting into multiple files and generating a playlist file.

I'd love to see if anyone makes anything, feel free to get in touch trough the issues.

## Credits
- [Yellowsone](https://github.com/mbullington/yellowstone), especially [Roger Hardiman](https://github.com/RogerHardiman), who implemented support for H265 just for me
- [node-video-lib](https://github.com/gkozlenko/node-video-lib) for the base of this implementation


## License
Like all the project this is licenced under MIT