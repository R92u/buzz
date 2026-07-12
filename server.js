// BUZZ — сервер игры-баззера
// Запуск: npm install && npm start

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/*  СТАТИКА (отдаём public/)                                           */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ */
/*  ИГРОВОЕ СОСТОЯНИЕ (в памяти)                                       */
/* ------------------------------------------------------------------ */
/*
  lobby = {
    code, hostId, hostName,
    players: Map<playerId, {id, name, score, ws}>,
    status: 'lobby' | 'playing',
    roundState: 'idle' | 'voting' | 'buzzed' | 'reviewing',
    buzzedBy: playerId | null,
    submittedText: string | null,
    createdAt
  }
*/
const lobbies = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (lobbies.has(code));
  return code;
}
function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function uniqueName(lobby, name) {
  const taken = new Set([...lobby.players.values()].map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has(`${name}${i}`.toLowerCase())) i++;
  return `${name}${i}`;
}

/** Публичное состояние лобби (без ws-объектов) */
function lobbyView(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    hostName: lobby.hostName,
    status: lobby.status,
    roundState: lobby.roundState,
    buzzedBy: lobby.buzzedBy,
    buzzedByName: lobby.buzzedBy ? lobby.players.get(lobby.buzzedBy)?.name ?? null : null,
    submittedText: lobby.submittedText,
    players: [...lobby.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

function lobbyListView() {
  return [...lobbies.values()].map(l => ({
    code: l.code,
    hostName: l.hostName,
    status: l.status,
    playerCount: l.players.size,
  }));
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
}

function broadcastLobby(lobby) {
  const view = lobbyView(lobby);
  for (const p of lobby.players.values()) send(p.ws, 'lobby', { lobby: view });
}

/** Все, кто сейчас в главном меню, получают свежий список лобби */
function broadcastLobbyList() {
  const list = lobbyListView();
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && !ws.lobbyCode) send(ws, 'lobbyList', { lobbies: list });
  }
}

function isHost(lobby, ws) {
  return lobby && lobby.hostId === ws.playerId;
}

function removeFromLobby(ws) {
  const lobby = lobbies.get(ws.lobbyCode);
  ws.lobbyCode = null;
  if (!lobby) return;

  lobby.players.delete(ws.playerId);

  // если вышел тот, кто нажал баззер — сбрасываем раунд
  if (lobby.buzzedBy === ws.playerId) {
    lobby.buzzedBy = null;
    lobby.submittedText = null;
    lobby.roundState = lobby.status === 'playing' ? 'idle' : 'idle';
  }

  // ушёл ведущий или лобби опустело — закрываем
  if (lobby.hostId === ws.playerId || lobby.players.size === 0) {
    for (const p of lobby.players.values()) {
      p.ws.lobbyCode = null;
      send(p.ws, 'kicked', { reason: 'Ведущий закрыл лобби' });
    }
    lobbies.delete(lobby.code);
  } else {
    broadcastLobby(lobby);
  }
  broadcastLobbyList();
}

/* ------------------------------------------------------------------ */
/*  WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.playerId = makeId();
  ws.lobbyCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, 'welcome', { playerId: ws.playerId });
  send(ws, 'lobbyList', { lobbies: lobbyListView() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const lobby = ws.lobbyCode ? lobbies.get(ws.lobbyCode) : null;

    switch (msg.type) {

      /* ---------- главное меню ---------- */
      case 'listLobbies':
        send(ws, 'lobbyList', { lobbies: lobbyListView() });
        break;

      case 'createLobby': {
        const name = String(msg.name || '').trim().slice(0, 16);
        if (!name) return send(ws, 'error', { message: 'Введите ник' });
        if (ws.lobbyCode) removeFromLobby(ws);

        const code = makeCode();
        const newLobby = {
          code,
          hostId: ws.playerId,
          hostName: name,
          players: new Map(),
          status: 'lobby',
          roundState: 'idle',
          buzzedBy: null,
          submittedText: null,
          createdAt: Date.now(),
        };
        newLobby.players.set(ws.playerId, { id: ws.playerId, name, score: 0, ws });
        lobbies.set(code, newLobby);
        ws.lobbyCode = code;

        send(ws, 'joined', { code, you: { id: ws.playerId, name }, isHost: true });
        broadcastLobby(newLobby);
        broadcastLobbyList();
        break;
      }

      case 'joinLobby': {
        const name = String(msg.name || '').trim().slice(0, 16);
        const code = String(msg.code || '').trim().toUpperCase();
        if (!name) return send(ws, 'error', { message: 'Введите ник' });

        const target = lobbies.get(code);
        if (!target) return send(ws, 'error', { message: 'Лобби не найдено' });
        if (target.status !== 'lobby') return send(ws, 'error', { message: 'Игра уже началась' });

        if (ws.lobbyCode) removeFromLobby(ws);

        const finalName = uniqueName(target, name);
        target.players.set(ws.playerId, { id: ws.playerId, name: finalName, score: 0, ws });
        ws.lobbyCode = code;

        send(ws, 'joined', { code, you: { id: ws.playerId, name: finalName }, isHost: false });
        broadcastLobby(target);
        broadcastLobbyList();
        break;
      }

      case 'leaveLobby':
        removeFromLobby(ws);
        send(ws, 'left');
        send(ws, 'lobbyList', { lobbies: lobbyListView() });
        break;

      /* ---------- действия ведущего ---------- */
      case 'startGame':
        if (!isHost(lobby, ws)) return;
        lobby.status = 'playing';
        lobby.roundState = 'idle';
        lobby.buzzedBy = null;
        lobby.submittedText = null;
        broadcastLobby(lobby);
        broadcastLobbyList();
        break;

      case 'startVoting':
        if (!isHost(lobby, ws) || lobby.status !== 'playing') return;
        lobby.roundState = 'voting';
        lobby.buzzedBy = null;
        lobby.submittedText = null;
        broadcastLobby(lobby);
        break;

      case 'newRound':
        if (!isHost(lobby, ws) || lobby.status !== 'playing') return;
        lobby.roundState = 'idle';
        lobby.buzzedBy = null;
        lobby.submittedText = null;
        broadcastLobby(lobby);
        break;

      case 'decide': {
        if (!isHost(lobby, ws) || lobby.roundState !== 'reviewing') return;
        if (msg.approve && lobby.buzzedBy) {
          const p = lobby.players.get(lobby.buzzedBy);
          if (p) p.score += 1;
        }
        lobby.roundState = 'idle';
        lobby.buzzedBy = null;
        lobby.submittedText = null;
        broadcastLobby(lobby);
        break;
      }

      /* ---------- действия игрока ---------- */
      case 'buzz': {
        if (!lobby) return;
        // ЗАЩИТА ОТ ОДНОВРЕМЕННОГО НАЖАТИЯ:
        // Node обрабатывает сообщения по одному, так что первый дошедший
        // пакет займёт слот, а все следующие увидят roundState !== 'voting'.
        if (lobby.roundState !== 'voting') return;
        if (lobby.buzzedBy) return;
        if (!lobby.players.has(ws.playerId)) return;

        lobby.buzzedBy = ws.playerId;
        lobby.roundState = 'buzzed';
        broadcastLobby(lobby);
        break;
      }

      case 'submitAnswer': {
        if (!lobby) return;
        if (lobby.roundState !== 'buzzed') return;
        if (lobby.buzzedBy !== ws.playerId) return;   // писать может только нажавший
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;

        lobby.submittedText = text;
        lobby.roundState = 'reviewing';
        broadcastLobby(lobby);
        break;
      }
    }
  });

  ws.on('close', () => { removeFromLobby(ws); });
});

/* ---- keepalive: рвём мёртвые соединения (важно за nginx/heroku) ---- */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/* ---- уборка заброшенных лобби (пустые > 2 часов) ---- */
setInterval(() => {
  const now = Date.now();
  for (const [code, l] of lobbies) {
    if (l.players.size === 0 && now - l.createdAt > 2 * 3600 * 1000) lobbies.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`BUZZ запущен → http://localhost:${PORT}`);
});
