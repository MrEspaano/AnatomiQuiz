const MAX_NAME_LENGTH = 16;
const MIN_NAME_LENGTH = 2;
const MAX_ROWS = 20;
const ALLOWED_MODES = new Set(["skeleton", "muscle"]);
const BANNED_TERMS = [
  "fan",
  "fitta",
  "hora",
  "kuk",
  "cp",
  "idiot",
  "jävla",
  "fuck",
  "shit",
  "bitch",
  "nigger",
  "retard",
  "naz",
];

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasBlockedTerms(name) {
  const lower = name.toLowerCase();
  return BANNED_TERMS.some((term) => lower.includes(term));
}

function isValidName(name) {
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) return false;
  return /^[a-zA-Z0-9åäöÅÄÖ _-]+$/.test(name);
}

function rankSort(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.duration_ms !== b.duration_ms) return a.duration_ms - b.duration_ms;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

function isBetterResult(next, prev) {
  if (!prev) return true;
  if (next.score > prev.score) return true;
  if (next.score < prev.score) return false;
  return next.duration_ms < prev.duration_ms;
}

function getApiBaseUrl() {
  const url = process.env.SUPABASE_URL;
  return typeof url === "string" ? url.replace(/\/+$/, "") : "";
}

async function supabaseRequest(path, { method = "GET", key, body } = {}) {
  const apiBase = getApiBaseUrl();
  if (!apiBase) {
    throw new Error("SUPABASE_URL saknas");
  }
  if (!key) {
    throw new Error("Supabase API-nyckel saknas");
  }

  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const message = typeof parsed === "string" ? parsed : parsed?.message || "Supabase-fel";
    throw new Error(message);
  }

  return parsed;
}

async function listEntries(mode) {
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const query = `/rest/v1/leaderboard_entries?mode=eq.${encodeURIComponent(mode)}&select=id,mode,player_name,score,max_score,duration_ms,accuracy_percent,created_at&order=score.desc,duration_ms.asc,created_at.asc&limit=${MAX_ROWS}`;
  const rows = await supabaseRequest(query, { method: "GET", key: anonKey });
  return Array.isArray(rows) ? rows : [];
}

async function findEntryByName(mode, normalizedName) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const query = `/rest/v1/leaderboard_entries?mode=eq.${encodeURIComponent(mode)}&player_name=eq.${encodeURIComponent(normalizedName)}&select=id,mode,player_name,score,max_score,duration_ms,accuracy_percent,created_at&limit=1`;
  const rows = await supabaseRequest(query, { method: "GET", key: serviceKey });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function upsertBestEntry(payload) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const existing = await findEntryByName(payload.mode, payload.player_name);
  if (!isBetterResult(payload, existing)) {
    return { updated: false, entry: existing };
  }

  if (existing?.id) {
    const updatedRows = await supabaseRequest(
      `/rest/v1/leaderboard_entries?id=eq.${encodeURIComponent(existing.id)}`,
      { method: "PATCH", key: serviceKey, body: payload }
    );
    return { updated: true, entry: Array.isArray(updatedRows) ? updatedRows[0] : null };
  }

  const insertedRows = await supabaseRequest("/rest/v1/leaderboard_entries", {
    method: "POST",
    key: serviceKey,
    body: payload,
  });
  return { updated: true, entry: Array.isArray(insertedRows) ? insertedRows[0] : null };
}

async function deleteEntry(id) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await supabaseRequest(`/rest/v1/leaderboard_entries?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    key: serviceKey,
  });
}

export default async function handler(req, res) {
  try {
    const method = req.method || "GET";
    if (method === "GET") {
      const mode = String(req.query?.mode || "skeleton");
      if (!ALLOWED_MODES.has(mode)) {
        return json(res, 400, { error: "Ogiltigt läge." });
      }
      const rows = await listEntries(mode);
      return json(res, 200, { entries: rows.sort(rankSort).slice(0, 10) });
    }

    if (method === "POST") {
      const mode = String(req.body?.mode || "");
      const playerName = normalizeName(req.body?.playerName);
      const score = Number(req.body?.score);
      const maxScore = Number(req.body?.maxScore);
      const durationMs = Number(req.body?.durationMs);

      if (!ALLOWED_MODES.has(mode)) return json(res, 400, { error: "Ogiltigt läge." });
      if (!isValidName(playerName)) return json(res, 400, { error: "Namn måste vara 2-16 tecken." });
      if (hasBlockedTerms(playerName)) return json(res, 400, { error: "Namnet är inte tillåtet." });
      if (!Number.isInteger(score) || !Number.isInteger(maxScore) || !Number.isInteger(durationMs)) {
        return json(res, 400, { error: "Ogiltig poäng eller tid." });
      }
      if (maxScore <= 0 || score < 0 || score > maxScore || durationMs < 0) {
        return json(res, 400, { error: "Resultatvärden utanför tillåtet intervall." });
      }

      const accuracyPercent = Math.max(0, Math.min(100, Math.round((score / maxScore) * 100)));
      const upsertPayload = {
        mode,
        player_name: playerName,
        score,
        max_score: maxScore,
        duration_ms: durationMs,
        accuracy_percent: accuracyPercent,
      };
      const upsertResult = await upsertBestEntry(upsertPayload);
      const rows = await listEntries(mode);
      return json(res, 200, {
        saved: upsertResult.updated,
        entry: upsertResult.entry,
        entries: rows.sort(rankSort).slice(0, 10),
      });
    }

    if (method === "DELETE") {
      const adminCode = String(req.body?.adminCode || "");
      const id = String(req.body?.id || "");
      if (!id) return json(res, 400, { error: "Saknar id." });
      if (!adminCode || adminCode !== process.env.LEADERBOARD_ADMIN_CODE) {
        return json(res, 403, { error: "Fel admin-kod." });
      }
      await deleteEntry(id);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: "Metod stöds inte." });
  } catch (error) {
    return json(res, 500, { error: error?.message || "Internt serverfel." });
  }
}
