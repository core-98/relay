type Participant = {
  id: string;
  name: string;
  role: "host" | "viewer";
  lastSeen: number;
};

type SignalEvent = {
  id: string;
  type: "peer-joined" | "peer-left" | "signal";
  from: string;
  data?: unknown;
  createdAt: number;
};

type Room = {
  hostId: string;
  createdAt: number;
  participants: Map<string, Participant>;
  queues: Map<string, SignalEvent[]>;
};

type RoomStore = typeof globalThis & {
  __peerPlayRooms?: Map<string, Room>;
};

const ROOM_TTL = 1000 * 60 * 60 * 6;
const EVENT_TTL = 1000 * 45;
const globalStore = globalThis as RoomStore;
const rooms = globalStore.__peerPlayRooms ?? new Map<string, Room>();
globalStore.__peerPlayRooms = rooms;

function clean() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL || room.participants.size === 0) {
      rooms.delete(code);
      continue;
    }

    for (const [peerId, participant] of room.participants) {
      if (now - participant.lastSeen > EVENT_TTL * 2) {
        room.participants.delete(peerId);
        room.queues.delete(peerId);
        for (const queue of room.queues.values()) {
          queue.push({
            id: crypto.randomUUID(),
            type: "peer-left",
            from: peerId,
            createdAt: now,
          });
        }
      }
    }

    for (const [peerId, queue] of room.queues) {
      room.queues.set(
        peerId,
        queue.filter((event) => now - event.createdAt < EVENT_TTL).slice(-120),
      );
    }
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: Request) {
  clean();
  const url = new URL(request.url);
  const code = (url.searchParams.get("room") ?? "").toUpperCase();
  const peerId = url.searchParams.get("peer") ?? "";
  const room = rooms.get(code);
  const participant = room?.participants.get(peerId);

  if (!room || !participant) {
    return json({ error: "Room or peer not found" }, 404);
  }

  participant.lastSeen = Date.now();
  const events = room.queues.get(peerId) ?? [];
  room.queues.set(peerId, []);

  return json({
    events,
    participants: [...room.participants.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      role: peer.role,
    })),
  });
}

export async function POST(request: Request) {
  clean();
  const body = (await request.json()) as {
    action?: string;
    room?: string;
    peerId?: string;
    name?: string;
    to?: string;
    data?: unknown;
  };
  const action = body.action;
  const code = (body.room ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const peerId = body.peerId ?? "";

  if (!code || !peerId) {
    return json({ error: "Room code and peer ID are required" }, 400);
  }

  if (action === "create") {
    if (rooms.has(code)) {
      return json({ error: "That room code is already active" }, 409);
    }

    const participant: Participant = {
      id: peerId,
      name: (body.name || "Host").slice(0, 40),
      role: "host",
      lastSeen: Date.now(),
    };
    rooms.set(code, {
      hostId: peerId,
      createdAt: Date.now(),
      participants: new Map([[peerId, participant]]),
      queues: new Map([[peerId, []]]),
    });
    return json({ ok: true });
  }

  const room = rooms.get(code);
  if (!room) {
    return json({ error: "Room not found or has ended" }, 404);
  }

  if (action === "join") {
    if (room.participants.size >= 6) {
      return json({ error: "This room is full" }, 409);
    }
    if (!room.participants.has(peerId)) {
      const participant: Participant = {
        id: peerId,
        name: (body.name || "Guest").slice(0, 40),
        role: "viewer",
        lastSeen: Date.now(),
      };
      room.participants.set(peerId, participant);
      room.queues.set(peerId, []);
      room.queues.get(room.hostId)?.push({
        id: crypto.randomUUID(),
        type: "peer-joined",
        from: peerId,
        data: { name: participant.name },
        createdAt: Date.now(),
      });
    }
    return json({ ok: true, hostId: room.hostId });
  }

  if (!room.participants.has(peerId)) {
    return json({ error: "Peer not found" }, 404);
  }

  if (action === "signal") {
    const recipient = body.to ?? "";
    const queue = room.queues.get(recipient);
    if (!queue) return json({ error: "Recipient is no longer connected" }, 404);
    queue.push({
      id: crypto.randomUUID(),
      type: "signal",
      from: peerId,
      data: body.data,
      createdAt: Date.now(),
    });
    return json({ ok: true });
  }

  if (action === "leave") {
    room.participants.delete(peerId);
    room.queues.delete(peerId);
    for (const queue of room.queues.values()) {
      queue.push({
        id: crypto.randomUUID(),
        type: "peer-left",
        from: peerId,
        createdAt: Date.now(),
      });
    }
    if (peerId === room.hostId || room.participants.size === 0) rooms.delete(code);
    return json({ ok: true });
  }

  // Removing a viewer is a host-only action: it drops their signalling seat so
  // they cannot renegotiate their way back in with the same room code.
  if (action === "evict") {
    if (peerId !== room.hostId) {
      return json({ error: "Only the host can remove a viewer" }, 403);
    }
    const target = body.to ?? "";
    if (target === room.hostId || !room.participants.has(target)) {
      return json({ error: "That viewer is not in the room" }, 404);
    }
    room.participants.delete(target);
    room.queues.delete(target);
    for (const queue of room.queues.values()) {
      queue.push({
        id: crypto.randomUUID(),
        type: "peer-left",
        from: target,
        createdAt: Date.now(),
      });
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
}
