import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Create Vite server in middleware mode and configure the app type as
    // 'custom', disabling Vite's own HTML serving logic so parent server
    // can take control
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });

    // Use vite's connect instance as middleware. If you use your own
    // express router (express.Router()), you should use router.use
    app.use(vite.middlewares);
  } else {
    // In production, serve the built files
    app.use(express.static(path.resolve(__dirname, 'dist')));
  }

  // Game State
  const rooms = new Map();
  const playerSockets = new Map();

  const GAME_CONTENT = [
    {
      headline: "Bildungsministerium plant Abschaffung der Sommerferien ab 2027!",
      content: "Um den Unterrichtsausfall auszugleichen, sollen die großen Ferien komplett gestrichen werden. Stattdessen gibt es nur noch vereinzelt lange Wochenenden.",
      isFake: true,
      clues: [
          "Der Account 'KultusMinister_Real' hat nur 14 Follower und existiert erst seit drei Tagen.",
          "Keine seriöse Nachrichten-Website (wie Tagesschau oder Spiegel) berichtet darüber.",
          "Das Profilbild des Posts ist KI-generiert (erkennbar an seltsamen Händen im Hintergrund).",
          "Der aktuelle Bildungsminister hat laut offiziellem Account eine solche Planung nie erwähnt."
      ],
      explanation: "Fake! Solche Nachrichten sollen maximale Empörung auslösen. Der Absender ist kein offizieller Account, sondern ein Troll, der Klicks sammeln will.",
    },
    {
      headline: "Achtung! Beliebter Energy-Drink 'VoltBlast' führt zu plötzlichen Blackouts!",
      content: "Eine Studie zeigt, dass neue Inhaltsstoffe im Getränk die Hirnströme stören. Bereits zahlreiche Krankenhauseinlieferungen! Teilt das sofort um alle zu warnen!!!",
      isFake: true,
      clues: [
          "Das Bundesinstitut für Risikobewertung (BfR) hat keinerlei offizielle Warnung herausgegeben.",
          "Die verlinkte 'Wissenschafts-Seite' hat kein gültiges Impressum.",
          "Der Post wurde von einem Account gestartet, der Werbung für eine andere, konkurrierende Marke macht.",
          "Das Bild des Krankenhauses im Post ist ein Stock-Foto und keine reale Notaufnahme."
      ],
      explanation: "Fake! Diese Nachricht spielt mit rohen Ängsten und nutzt den panischen Aufruf 'Teilt das sofort', um sich rasant zu verbreiten, ohne Fakten zu liefern."
    },
    {
      headline: "Neue Studie: Social Media Algorithmen bevorzugen Beiträge, die uns wütend machen.",
      content: "Forscher haben nachgewiesen, dass Posts mit stark negativen, spaltenden Emotionen von Algorithmen häufiger angezeigt werden, weil Nutzer länger darauf reagieren.",
      isFake: false,
      clues: [
          "Verifizierte Medien berichten über diese Studie aus einer echten, bekannten Fachzeitschrift.",
          "Ehemalige Mitarbeiter (Whistleblower) von Tech-Konzernen haben dieses Prinzip in Interviews bestätigt.",
          "Der Post ist ruhig und sachlich formatiert und verlinkt auf eine Uni-Website.",
          "Es fehlt die typische Panikmache – es wird lediglich auf einen Bericht verwiesen."
      ],
      explanation: "Fakt! Leider ist dies eine echte Erkenntnis. Da extreme Emotionen für mehr Interaktion sorgen, pushen Algorithmen solche Inhalte, um uns länger in der App zu halten."
    }
  ];

  const getRoom = (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        players: [],
        host: null,
        status: 'waiting', // waiting, playing, result
        currentArticleIndex: 0,
        currentArticle: null,
        votes: {},
      });
    }
    return rooms.get(roomId);
  };

  const broadcastRoomState = (roomId) => {
    const room = rooms.get(roomId);
    if(room) {
      io.to(roomId).emit('room_state', room);
    }
  };

  // Socket.io connection handling
  io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join_room', ({ username, room: roomId }) => {
      socket.join(roomId);
      playerSockets.set(socket.id, roomId);
      
      const room = getRoom(roomId);
      
      // Update player if already exists, else add
      const existing = room.players.find(p => p.id === socket.id);
      if(!existing) {
          room.players.push({ id: socket.id, username });
      } else {
          existing.username = username;
      }

      if(!room.host) room.host = socket.id;

      broadcastRoomState(roomId);
    });

    socket.on('chat_message', (data) => {
      const { room, text } = data;
      const r = rooms.get(room);
      if(r) {
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
          io.to(room).emit('chat_message', { username: p.username, text });
        }
      }
    });

    socket.on('action', (data) => {
      const { room: roomId, type, payload } = data;
      
      if(type === 'play_vs_bots') {
          const botRoomId = "BOT-" + Math.floor(Math.random()*10000);
          socket.join(botRoomId);
          playerSockets.set(socket.id, botRoomId);
          const room = getRoom(botRoomId);
          room.players.push({ id: socket.id, username: payload.username });
          room.host = socket.id;
          room.isBotRoom = true;
          room.players.push({ id: "bot1", username: "Agent Alpha (Bot)", isBot: true });
          room.players.push({ id: "bot2", username: "Agent Beta (Bot)", isBot: true });
          
          socket.emit('bot_room_joined', botRoomId);
          broadcastRoomState(botRoomId);
          return;
      }

      const room = rooms.get(roomId);
      if(!room) return;

      if(type === 'start_game' && room.host === socket.id) {
        room.status = 'playing';
        room.currentArticleIndex = 0;
        room.currentArticle = GAME_CONTENT[0];
        room.votes = {};
        broadcastRoomState(roomId);
        triggerBotBehavior(room);
      }
      else if(type === 'next_round' && room.host === socket.id) {
        room.currentArticleIndex++;
        if(room.currentArticleIndex >= GAME_CONTENT.length) {
          room.currentArticleIndex = 0; // wrap around for fun
        }
        room.currentArticle = GAME_CONTENT[room.currentArticleIndex];
        room.votes = {};
        room.status = 'playing';
        broadcastRoomState(roomId);
        triggerBotBehavior(room);
      }
      else if(type === 'submit_vote' && room.status === 'playing') {
        room.votes[socket.id] = { playerId: socket.id, vote: payload };
        
        // Check if all players have voted
        if(Object.keys(room.votes).length === room.players.length) {
           room.status = 'result';
        }
        broadcastRoomState(roomId);
      }
    });

    function triggerBotBehavior(room) {
      if(room.isBotRoom) {
         setTimeout(() => {
             const currentRoom = rooms.get(room.id);
             if(currentRoom && currentRoom.status === 'playing') {
                 // Bot votes (slightly smart or just random)
                 const correctAns = currentRoom.currentArticle.isFake ? 'fake' : 'fakt';
                 
                 currentRoom.votes["bot1"] = { playerId: "bot1", vote: Math.random() > 0.2 ? correctAns : (correctAns === 'fake' ? 'fakt' : 'fake') };
                 currentRoom.votes["bot2"] = { playerId: "bot2", vote: Math.random() > 0.4 ? correctAns : (correctAns === 'fake' ? 'fakt' : 'fake') };
                 
                 io.to(room.id).emit('chat_message', { username: "Agent Alpha (Bot)", text: "Ich denke, ich weiß die Lösung." });

                 if(Object.keys(currentRoom.votes).length === currentRoom.players.length) {
                    currentRoom.status = 'result';
                 }
                 broadcastRoomState(room.id);
             }
         }, 3500);
      }
    }

    socket.on('disconnect', () => {
      const roomId = playerSockets.get(socket.id);
      if(roomId) {
        const room = rooms.get(roomId);
        if(room) {
          room.players = room.players.filter(p => p.id !== socket.id);
          delete room.votes[socket.id];
          
          if(room.players.length === 0) {
            rooms.delete(roomId);
          } else {
            if(room.host === socket.id) {
              room.host = room.players[0].id; // Assign new host
            }
            if(room.status === 'playing' && room.players.length > 0 && Object.keys(room.votes).length === room.players.length) {
              room.status = 'result';
            }
            broadcastRoomState(roomId);
          }
        }
        playerSockets.delete(socket.id);
      }
      console.log('User disconnected:', socket.id);
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

startServer();
