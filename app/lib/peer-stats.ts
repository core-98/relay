/**
 * A small sampler over RTCPeerConnection.getStats(). Everything the room UI
 * reports about a connection — bitrate, round trip, packet loss, the picture
 * size actually being delivered — is measured here rather than assumed.
 */
export type TransportSample = {
  kbps: number;
  rtt: number;
  loss: number;
  height: number;
  at: number;
  bytes: number;
  packets: number;
  lost: number;
};

export const EMPTY_SAMPLE: TransportSample = {
  kbps: 0,
  rtt: 0,
  loss: 0,
  height: 0,
  at: 0,
  bytes: 0,
  packets: 0,
  lost: 0,
};

type Direction = "inbound" | "outbound";

export async function sampleTransport(
  pc: RTCPeerConnection,
  direction: Direction,
  previous: TransportSample,
): Promise<TransportSample> {
  const report = await pc.getStats().catch(() => null);
  if (!report) return previous;

  const next: TransportSample = { ...EMPTY_SAMPLE, at: Date.now() };
  const wanted = direction === "inbound" ? "inbound-rtp" : "outbound-rtp";

  report.forEach((entry) => {
    const stat = entry as Record<string, number | string | undefined>;

    if (stat.type === wanted && stat.kind === "video") {
      next.bytes +=
        Number(direction === "inbound" ? stat.bytesReceived : stat.bytesSent) || 0;
      next.packets +=
        Number(direction === "inbound" ? stat.packetsReceived : stat.packetsSent) || 0;
      next.height = Number(stat.frameHeight) || next.height;
      if (direction === "inbound") next.lost += Number(stat.packetsLost) || 0;
    }

    // The sender only learns about loss and round trip from the receiver report.
    if (stat.type === "remote-inbound-rtp" && stat.kind === "video") {
      next.lost += Number(stat.packetsLost) || 0;
      if (typeof stat.roundTripTime === "number") next.rtt = stat.roundTripTime * 1000;
    }

    if (stat.type === "candidate-pair" && stat.state === "succeeded") {
      if (typeof stat.currentRoundTripTime === "number") {
        next.rtt = stat.currentRoundTripTime * 1000;
      }
    }
  });

  const elapsed = (next.at - previous.at) / 1000;
  if (previous.at && elapsed > 0.2 && next.bytes >= previous.bytes) {
    next.kbps = Math.round(((next.bytes - previous.bytes) * 8) / elapsed / 1000);
    const packetDelta = next.packets - previous.packets;
    const lostDelta = Math.max(0, next.lost - previous.lost);
    next.loss =
      packetDelta + lostDelta > 0
        ? Math.min(100, (lostDelta / (packetDelta + lostDelta)) * 100)
        : 0;
  } else {
    next.kbps = previous.kbps;
    next.loss = previous.loss;
  }

  if (!next.rtt) next.rtt = previous.rtt;
  if (!next.height) next.height = previous.height;
  return next;
}

export function formatRate(kbps: number) {
  if (!kbps) return "—";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

/** The rung the picture is actually arriving at, not the cap that was asked for. */
export function rungForHeight(height: number) {
  if (!height) return "";
  if (height >= 1000) return "1080p";
  if (height >= 680) return "720p";
  if (height >= 440) return "480p";
  return "240p";
}
