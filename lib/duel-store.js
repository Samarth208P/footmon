const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Global memory store for local server development fallback
global.duelChallenges = global.duelChallenges || [];
global.duelEvents = global.duelEvents || [];
let supabaseDisabled = false;

function hasConfig() {
  return !supabaseDisabled && !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function cleanupStaleMemoryStore() {
  if (global.duelEvents && global.duelEvents.length > 500) {
    global.duelEvents = global.duelEvents.slice(-300);
  }
  if (global.duelChallenges && global.duelChallenges.length > 100) {
    const oneHourAgo = Date.now() - 3600000;
    global.duelChallenges = global.duelChallenges.filter(c => {
      if (c.status === "open" || c.status === "active") return true;
      const createdTime = new Date(c.created_at || Date.now()).getTime();
      return createdTime > oneHourAgo;
    });
  }
}

function buildUrl(path, searchParams) {
  const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
  if (searchParams) {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
}

async function supabaseRequest(path, { method = "GET", searchParams, body, headers } = {}) {
  const useInMemory = !hasConfig();

  if (!useInMemory) {
    try {
      const response = await fetch(buildUrl(path, searchParams), {
        method,
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Supabase request failed: ${response.status}`);
      }

      if (response.status === 204) return null;
      return await response.json();
    } catch (err) {
      if (!supabaseDisabled) {
        console.warn("[Duel Store] Supabase tables not found. Disabling Supabase remote calls & using fast local server memory.");
        supabaseDisabled = true;
      }
    }
  }

  // ── Local In-Memory Fallback ──
  if (path === "duel_challenges") {
    if (method === "GET") {
      if (searchParams?.duel_id) {
        const id = searchParams.duel_id.replace("eq.", "");
        const found = global.duelChallenges.filter(c => c.duel_id === id);
        return found;
      }
      return global.duelChallenges.filter(c => c.status === "open");
    }
    if (method === "POST") {
      const item = body[0];
      global.duelChallenges.push(item);
      return [item];
    }
    if (method === "PATCH") {
      const id = searchParams.duel_id.replace("eq.", "");
      const idx = global.duelChallenges.findIndex(c => c.duel_id === id);
      if (idx !== -1) {
        global.duelChallenges[idx] = {
          ...global.duelChallenges[idx],
          ...body,
          updated_at: new Date().toISOString()
        };
        return [global.duelChallenges[idx]];
      }
      return [];
    }
  }

  if (path === "duel_events") {
    if (method === "GET") {
      const id = searchParams.duel_id.replace("eq.", "");
      const gtId = parseInt(searchParams.id.replace("gt.", "") || "0");
      return global.duelEvents.filter(e => e.duel_id === id && e.id > gtId);
    }
    if (method === "POST") {
      const item = {
        id: global.duelEvents.length + 1,
        ...body[0],
        created_at: new Date().toISOString()
      };
      global.duelEvents.push(item);
      return [item];
    }
  }
  return [];
}

export async function listOpenChallenges() {
  return supabaseRequest("duel_challenges", {
    searchParams: {
      select: "duel_id,creator,joiner,stake,session_pub_key,status,created_at,updated_at",
      status: "eq.open",
      order: "created_at.desc",
    },
  });
}

export async function getChallenge(duelId) {
  const rows = await supabaseRequest("duel_challenges", {
    searchParams: {
      select: "duel_id,creator,joiner,stake,session_pub_key,status,created_at,updated_at",
      duel_id: `eq.${duelId}`,
      limit: "1",
    },
  });
  return rows[0] || null;
}

export async function createChallenge(challenge) {
  const rows = await supabaseRequest("duel_challenges", {
    method: "POST",
    body: [{
      duel_id: challenge.duelId,
      creator: challenge.creator,
      stake: challenge.stake,
      session_pub_key: challenge.sessionPubKey,
      status: "open",
    }],
  });
  return rows[0];
}

export async function joinChallenge(duelId, joiner) {
  const rows = await supabaseRequest("duel_challenges", {
    method: "PATCH",
    searchParams: {
      duel_id: `eq.${duelId}`,
      status: "eq.open",
    },
    body: {
      joiner,
      status: "active",
      updated_at: new Date().toISOString(),
    },
  });
  return rows[0] || null;
}

export async function updateChallengeStatus(duelId, status) {
  const rows = await supabaseRequest("duel_challenges", {
    method: "PATCH",
    searchParams: {
      duel_id: `eq.${duelId}`,
    },
    body: {
      status,
      updated_at: new Date().toISOString(),
    },
  });
  return rows[0] || null;
}

export async function createEvent(event) {
  const rows = await supabaseRequest("duel_events", {
    method: "POST",
    body: [{
      duel_id: event.duelId,
      sender: event.sender,
      type: event.type,
      payload: event.payload,
    }],
  });
  return rows[0];
}

export async function listEvents(duelId, afterId = 0) {
  return supabaseRequest("duel_events", {
    searchParams: {
      select: "id,duel_id,sender,type,payload,created_at",
      duel_id: `eq.${duelId}`,
      id: `gt.${afterId}`,
      order: "id.asc",
    },
  });
}
