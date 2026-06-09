const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "16kb" }));

// ============================================================
// 1. LOBBY DATA STRUCTURE (in-memory store)
// ============================================================
// JSON Schema for each lobby:
// {
//   "lobbyId": "uuid",
//   "hostName": "FarmerName",
//   "farmName": "MyFarm",
//   "currentPlayers": 1,
//   "maxPlayers": 4,
//   "ipAddress": "1.2.3.4",
//   "port": 24642,
//   "inGameDate": "Summer 3, Year 1",
//   "inGameDay": 13,
//   "modVersionHash": "sha256ofmodlist",
//   "modNames": ["MobileFastOptimizer", "AutoChestOrganizer"],
//   "isPasswordProtected": false,
//   "platform": "android" | "pc",
//   "gameVersion": "1.6.15",
//   "lastHeartbeat": 1717000000000 (ms timestamp),
//   "createdAt": 1717000000000 (ms timestamp)
// }

const lobbies = new Map(); // lobbyId -> lobby object

// ============================================================
// 4. SECURITY: TTL CLEANUP (every 15s, remove stale lobbies)
// ============================================================
const LOBBY_TTL_MS = 60_000; // 60 seconds without heartbeat = stale

function cleanupStaleLobbies() {
  const now = Date.now();
  let removed = 0;
  for (const [id, lobby] of lobbies) {
    if (now - lobby.lastHeartbeat > LOBBY_TTL_MS) {
      lobbies.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} stale lobby(s)`);
  }
}
setInterval(cleanupStaleLobbies, 15_000);

// ============================================================
// 4. SECURITY: RATE LIMITING
// ============================================================
const announceLimiter = rateLimit({
  windowMs: 30_000,
  max: 10,
  message: { error: "Too many announce requests. Max 10 per 30s." },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: "Too many requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 2. MASTER SERVER API ENDPOINTS
// ============================================================

// POST /api/lobbies/announce - Host heartbeat (every 30s)
app.post("/api/lobbies/announce", announceLimiter, (req, res) => {
  try {
    const {
      hostName,
      farmName,
      currentPlayers,
      maxPlayers,
      ipAddress,
      port,
      inGameDate,
      inGameDay,
      modVersionHash,
      modNames,
      isPasswordProtected,
      platform,
      gameVersion,
      lobbyId: existingId,
    } = req.body;

    // Validation
    if (!hostName || !farmName || !ipAddress || !port) {
      return res.status(400).json({
        error: "Missing required fields: hostName, farmName, ipAddress, port",
      });
    }
    if (typeof port !== "number" || port < 1024 || port > 65535) {
      return res.status(400).json({ error: "Port must be between 1024-65535" });
    }
    if (typeof ipAddress !== "string" || ipAddress.length > 45) {
      return res.status(400).json({ error: "Invalid ipAddress" });
    }

    const now = Date.now();
    let lobby;

    if (existingId && lobbies.has(existingId)) {
      // Update existing lobby
      lobby = lobbies.get(existingId);
      lobby.hostName = hostName;
      lobby.farmName = farmName;
      lobby.currentPlayers = currentPlayers ?? lobby.currentPlayers;
      lobby.maxPlayers = maxPlayers ?? lobby.maxPlayers;
      lobby.ipAddress = ipAddress;
      lobby.port = port;
      lobby.inGameDate = inGameDate ?? lobby.inGameDate;
      lobby.inGameDay = inGameDay ?? lobby.inGameDay;
      lobby.modVersionHash = modVersionHash ?? lobby.modVersionHash;
      lobby.modNames = modNames ?? lobby.modNames;
      lobby.isPasswordProtected = isPasswordProtected ?? lobby.isPasswordProtected;
      lobby.platform = platform ?? lobby.platform;
      lobby.gameVersion = gameVersion ?? lobby.gameVersion;
      lobby.lastHeartbeat = now;
    } else {
      // Create new lobby
      const lobbyId = crypto.randomUUID();
      lobby = {
        lobbyId,
        hostName,
        farmName,
        currentPlayers: currentPlayers ?? 1,
        maxPlayers: maxPlayers ?? 4,
        ipAddress,
        port,
        inGameDate: inGameDate ?? "",
        inGameDay: inGameDay ?? 0,
        modVersionHash: modVersionHash ?? "",
        modNames: modNames ?? [],
        isPasswordProtected: isPasswordProtected ?? false,
        platform: platform ?? "pc",
        gameVersion: gameVersion ?? "",
        lastHeartbeat: now,
        createdAt: now,
      };
      lobbies.set(lobbyId, lobby);
    }

    console.log(`[Announce] ${lobby.hostName}'s farm "${lobby.farmName}" (${lobby.lobbyId})`);

    return res.json({
      success: true,
      lobbyId: lobby.lobbyId,
      ttlMs: LOBBY_TTL_MS,
    });
  } catch (err) {
    console.error("[Announce Error]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/lobbies - Client fetches room list with optional filters
app.get("/api/lobbies", generalLimiter, (req, res) => {
  try {
    const {
      platform,       // filter: "android" | "pc"
      modVersionHash, // filter: only show rooms with matching mod hash
      search,         // filter: text search on farmName / hostName
      hasPassword,    // filter: "true" | "false"
    } = req.query;

    const now = Date.now();
    const results = [];

    for (const lobby of lobbies.values()) {
      if (now - lobby.lastHeartbeat > LOBBY_TTL_MS) continue;

      if (platform && lobby.platform !== platform) continue;
      if (modVersionHash && lobby.modVersionHash !== modVersionHash) continue;
      if (hasPassword === "true" && !lobby.isPasswordProtected) continue;
      if (hasPassword === "false" && lobby.isPasswordProtected) continue;
      if (search) {
        const q = search.toLowerCase();
        if (
          !lobby.hostName.toLowerCase().includes(q) &&
          !lobby.farmName.toLowerCase().includes(q)
        ) {
          continue;
        }
      }

      results.push({
        lobbyId: lobby.lobbyId,
        hostName: lobby.hostName,
        farmName: lobby.farmName,
        currentPlayers: lobby.currentPlayers,
        maxPlayers: lobby.maxPlayers,
        inGameDate: lobby.inGameDate,
        inGameDay: lobby.inGameDay,
        modNames: lobby.modNames,
        isPasswordProtected: lobby.isPasswordProtected,
        platform: lobby.platform,
        gameVersion: lobby.gameVersion,
        ipAddress: lobby.ipAddress,
        port: lobby.port,
        // NOTE: ip/port are returned to client for direct connection
      });
    }

    // Sort by newest first
    results.sort((a, b) => b.inGameDay - a.inGameDay);

    return res.json({
      success: true,
      count: results.length,
      lobbies: results,
    });
  } catch (err) {
    console.error("[List Error]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/lobbies/close - Host closes room
app.delete("/api/lobbies/close", announceLimiter, (req, res) => {
  try {
    const { lobbyId, hostName } = req.body;

    if (!lobbyId) {
      return res.status(400).json({ error: "Missing lobbyId" });
    }

    const lobby = lobbies.get(lobbyId);
    if (!lobby) {
      return res.status(404).json({ error: "Lobby not found or already expired" });
    }

    // Optional: verify hostName matches to prevent abuse
    if (hostName && lobby.hostName !== hostName) {
      return res.status(403).json({ error: "hostName mismatch" });
    }

    lobbies.delete(lobbyId);
    console.log(`[Close] Lobby ${lobbyId} (${lobby.hostName}'s farm) closed`);

    return res.json({ success: true });
  } catch (err) {
    console.error("[Close Error]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", activeLobbies: lobbies.size });
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`[MasterServer] UniversalLANBrowser running on port ${PORT}`);
  console.log(`[MasterServer] Lobby TTL: ${LOBBY_TTL_MS / 1000}s`);
  console.log(`[MasterServer] Cleanup interval: 15s`);
});
