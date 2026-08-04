/** LiveTalking WebRTC 客户端：拉流并拿到 sessionid，供后端 humanaudio 驱动。 */

export type LiveTalkingSession = {
  pc: RTCPeerConnection;
  sessionid: string | number;
  stream: MediaStream | null;
  close: () => void;
};

export async function connectLiveTalking(opts: {
  offerUrl: string;
  avatar?: string;
  onTrack?: (stream: MediaStream) => void;
}): Promise<LiveTalkingSession> {
  const pc = new RTCPeerConnection();
  let stream: MediaStream | null = null;
  let sessionid: string | number = "";

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    if (ev.streams && ev.streams[0]) {
      stream = ev.streams[0];
    } else {
      if (!stream) stream = new MediaStream();
      stream.addTrack(ev.track);
    }
    if (stream) opts.onTrack?.(stream);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });

  const local = pc.localDescription;
  if (!local) throw new Error("WebRTC localDescription empty");

  const body: Record<string, unknown> = {
    sdp: local.sdp,
    type: local.type,
  };
  if (opts.avatar) body.avatar = opts.avatar;

  const res = await fetch(opts.offerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as {
    code?: number;
    msg?: string;
    sdp?: string;
    type?: string;
    sessionid?: string | number;
  };
  if (answer.code && answer.code !== 0) {
    throw new Error(answer.msg || "LiveTalking offer error");
  }
  if (!answer.sdp) throw new Error("LiveTalking returned no SDP");
  if (answer.sessionid !== undefined && answer.sessionid !== null) {
    sessionid = answer.sessionid;
  }
  await pc.setRemoteDescription(
    new RTCSessionDescription({ type: (answer.type as RTCSdpType) || "answer", sdp: answer.sdp }),
  );

  return {
    pc,
    sessionid,
    stream,
    close: () => {
      try {
        pc.getReceivers().forEach((r) => r.track?.stop());
        pc.close();
      } catch {
        /* ignore */
      }
    },
  };
}
