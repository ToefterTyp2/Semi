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
  const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

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
    app.use(express.static(path.resolve(__dirname, '.')));
  }

  // Game State
  const rooms = new Map();
  const playerSockets = new Map();

  const TOPIC_POOL = [
    { 
        topic: "Das Klima hat sich letztes Jahr um 2° C erwärmt.", 
        premade: "KLIMA-SCHOCK: Das Jahr, in dem die Erde brannte! Wir ignorieren 2° Grad! 🌍🔥",
        botHeadline: "2 GRAD! Politiker schauen tatenlos zu, während unser Planet KOCHT!" 
    },
    { 
        topic: "Eine neue KI löst Hausaufgaben in Rekordzeit.", 
        premade: "KI BEENDET DIE SCHULE! Warum Lehrer jetzt komplett überflüssig sind! 🤖📚",
        botHeadline: "Nie wieder lernen! So erledigt diese KI deine Hausaufgaben PERFEKT." 
    },
    { 
        topic: "Ein neues Gesetz zur Regulierung von Social Media wird debattiert.", 
        premade: "ENDE DES INTERNETS?! Dieses neue Gesetz zerstört Social Media für IMMER! 🚫📱",
        botHeadline: "GEHEIM-GESETZ geleakt: Wollen sie uns TikTok wegnehmen?!" 
    }
  ];

  const getRoom = (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        players: [],
        host: null,
        status: 'waiting', 
        phase: 1, 
        turn: 'journalist_turn', // journalist_turn, algo_turn, zuschauer_turn, round_result
        roundInfo: {
            topicObj: null,
            journalistPosts: [], // { authorId, text, isBot }
            algoChoice: null, // index of chosen post
            zuschauerChoice: null, // index of chosen post
            zuschauerVotes: {}, // { socketId: index }
            algoVotes: {}, // { socketId: index }
            results: {}
        }
      });
    }
    return rooms.get(roomId);
  };

  const broadcastRoomState = (roomId) => {
    const room = rooms.get(roomId);
    if(room) io.to(roomId).emit('room_state', room);
  };

  const assignRolesAndBots = (room) => {
      // Remove previous bots
      room.players = room.players.filter(p => !p.isBot);
      
      let jCount = room.players.filter(p => p.role === 'Journalist').length;
      let aCount = room.players.filter(p => p.role === 'Algorithmus').length;
      let zCount = room.players.filter(p => p.role === 'Zuschauer').length;
      let unassigned = room.players.filter(p => !p.role || p.role === 'Beobachter');

      // Auto-assign unassigned players to balance
      unassigned.forEach(p => {
          if (jCount <= aCount && jCount <= zCount) { p.role = 'Journalist'; jCount++; }
          else if (aCount <= jCount && aCount <= zCount) { p.role = 'Algorithmus'; aCount++; }
          else { p.role = 'Zuschauer'; zCount++; }
      });

      // Add bots if any role is empty
      let botIndex = 0;
      if (jCount === 0) {
          room.players.push({ id: `bot_${botIndex++}`, username: `KI Reporter`, isBot: true, role: 'Journalist' });
      }
      if (aCount === 0) {
          room.players.push({ id: `bot_${botIndex++}`, username: `KI Algorithmus`, isBot: true, role: 'Algorithmus' });
      }
      if (zCount === 0) {
          room.players.push({ id: `bot_${botIndex++}`, username: `KI Zuschauer`, isBot: true, role: 'Zuschauer' });
      }

      room.players.forEach((p) => {
          if(!p.role) p.role = 'Beobachter'; // fallback
          p.scoreReichweite = 0;
          p.scoreEngagement = 0;
          p.scoreZuschauer = 0;
      });
  };

  const calculateRoundResult = (room) => {
        let bestPostIdx = room.roundInfo.zuschauerChoice;
        let algoIdx = room.roundInfo.algoChoice;
        let pts = { reach: 0, engagement: 0, winnerAuthorId: null, algoWin: false };

        if (bestPostIdx !== null) {
            let p = room.roundInfo.journalistPosts[bestPostIdx];
            pts.winnerAuthorId = p.authorId;
            if (p.authorId !== 'system') {
                // Give journalist Reach
                let j = room.players.find(pl => pl.id === p.authorId);
                if(j) j.scoreReichweite = (j.scoreReichweite || 0) + 1;
                pts.reach = 1;
            }

            if (bestPostIdx === algoIdx) {
                // Algorithmus players get Engagement
                room.players.forEach(pl => {
                    if(pl.role === 'Algorithmus') {
                        pl.scoreEngagement = (pl.scoreEngagement || 0) + 1;
                    }
                });
                pts.algoWin = true;
                pts.engagement = 1;
            }
        }
        
        // Zuschauer get 1 point if they participated
        room.players.forEach(pl => {
            if(pl.role === 'Zuschauer') {
                pl.scoreZuschauer = (pl.scoreZuschauer || 0) + 1;
            }
        });

        room.roundInfo.results = pts;
  };
  
  const getTopic = (phase) => {
      return TOPIC_POOL[(phase - 1) % TOPIC_POOL.length];
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
          room.players.push({ id: socket.id, username, role: 'Beobachter', scoreReichweite:0, scoreEngagement:0, scoreZuschauer:0 });
      } else {
          existing.username = username;
      }

      if(!room.host) room.host = socket.id;

      broadcastRoomState(roomId);
    });

    socket.on('chat_message', (data) => {
      const { room, text, type } = data;
      const r = rooms.get(room);
      if(r) {
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
          if (type === 'team') {
            const teamPlayers = r.players.filter(pl => pl.role === p.role);
            teamPlayers.forEach(tp => {
              if (tp.id && !tp.isBot) {
                io.to(tp.id).emit('chat_message', { username: p.username, text, type: 'team' });
              }
            });
          } else {
            io.to(room).emit('chat_message', { username: p.username, text, type: 'all' });
          }
        }
      }
    });

    const handleAction = (socket, data) => {
      const { room: roomId, type, payload, isBotSrc, botId } = data;
      const actorId = socket ? socket.id : botId;
      
      if(type === 'play_vs_bots') {
          const botRoomId = "BOT-" + Math.floor(Math.random()*10000);
          socket.join(botRoomId);
          playerSockets.set(socket.id, botRoomId);
          const room = getRoom(botRoomId);
          room.players.push({ id: socket.id, username: payload.username });
          room.host = socket.id;
          room.isBotRoom = true;
          // We don't add bots here immediately; start_game will do it
          
          socket.emit('bot_room_joined', botRoomId);
          broadcastRoomState(botRoomId);
          return;
      }

      const room = rooms.get(roomId);
      if(!room) return;

      if(type === 'change_role' && room.status === 'waiting') {
          let p = room.players.find(pl => pl.id === actorId);
          if(p) {
              p.role = payload.role;
              broadcastRoomState(roomId);
          }
      }
      else if(type === 'start_game' && room.host === actorId) {
        assignRolesAndBots(room);
        room.status = 'playing';
        room.phase = 1;
        room.turn = 'journalist_turn';
        room.roundInfo = {
            topicObj: getTopic(room.phase),
            journalistPosts: [],
            algoChoice: null,
            zuschauerChoice: null,
            zuschauerVotes: {},
            algoVotes: {},
            results: {}
        };
        
        broadcastRoomState(roomId);
        triggerBotBehavior(room);
      }
      else if(type === 'journalist_action' && room.status === 'playing' && room.turn === 'journalist_turn') {
         // Verify player is journalist
         let p = room.players.find(pl => pl.id === actorId && pl.role === 'Journalist');
         if(!p) return;

         // Check if already posted
         if(room.roundInfo.journalistPosts.find(post => post.authorId === p.id)) return;

         room.roundInfo.journalistPosts.push({
             authorId: p.id,
             authorName: p.username,
             text: payload.text,
             isBot: p.isBot
         });

         const jCount = room.players.filter(pl => pl.role === 'Journalist').length;
         if (room.roundInfo.journalistPosts.length >= jCount) {
             // Add premade
             room.roundInfo.journalistPosts.push({
                 authorId: 'system',
                 authorName: 'System (Vorgefertigt)',
                 text: room.roundInfo.topicObj.premade,
                 isBot: true
             });
             room.roundInfo.journalistPosts.sort(() => Math.random() - 0.5);
             room.turn = 'algo_turn';
             triggerBotBehavior(room);
         }
         broadcastRoomState(roomId);
      }
      else if(type === 'algo_action' && room.status === 'playing' && room.turn === 'algo_turn') {
         let p = room.players.find(pl => pl.id === actorId && pl.role === 'Algorithmus');
         if(!p) return; 

         room.roundInfo.algoVotes[p.id] = payload.index;

         const aCount = room.players.filter(pl => pl.role === 'Algorithmus').length;
         if (Object.keys(room.roundInfo.algoVotes).length >= aCount) {
             let counts = {};
             Object.values(room.roundInfo.algoVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
             let bestIdx = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
             room.roundInfo.algoChoice = parseInt(bestIdx);
             room.turn = 'zuschauer_turn';
             triggerBotBehavior(room);
         }
         broadcastRoomState(roomId);
      }
      else if(type === 'zuschauer_action' && room.status === 'playing' && room.turn === 'zuschauer_turn') {
         let p = room.players.find(pl => pl.id === actorId && pl.role === 'Zuschauer');
         if(!p) return; 

         room.roundInfo.zuschauerVotes[p.id] = payload.index;

         const zCount = room.players.filter(pl => pl.role === 'Zuschauer').length;
         if (Object.keys(room.roundInfo.zuschauerVotes).length >= zCount) {
             let counts = {};
             Object.values(room.roundInfo.zuschauerVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
             let bestIdx = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
             room.roundInfo.zuschauerChoice = parseInt(bestIdx);
             
             calculateRoundResult(room);
             room.turn = 'round_result';
         }
         broadcastRoomState(roomId);
      }
      else if(type === 'next_round' && room.host === actorId) {
         room.phase++;
         if (room.phase > 3) {
             room.status = 'final_result';
             broadcastRoomState(roomId);
             return;
         }

         room.turn = 'journalist_turn';
         room.roundInfo = {
             topicObj: getTopic(room.phase),
             journalistPosts: [],
             algoChoice: null,
             zuschauerChoice: null,
             zuschauerVotes: {},
             algoVotes: {},
             results: {}
         };

         
         // Rotate roles
         const rOrder = room.players.map(p => p.role);
         rOrder.push(rOrder.shift()); // shift left
         room.players.forEach((p, i) => p.role = rOrder[i]);

         room.status = 'playing';
         broadcastRoomState(roomId);
         triggerBotBehavior(room, socket);
      }
    };

    socket.on('action', (data) => handleAction(socket, data));

    function triggerBotBehavior(room) {
      if(room.status === 'playing') {
         setTimeout(() => {
             const currentRoom = rooms.get(room.id);
             if(!currentRoom || currentRoom.status !== 'playing') return;
             
             // Find who needs to act
             const actingRole = currentRoom.turn === 'journalist_turn' ? 'Journalist' : 
                                 currentRoom.turn === 'algo_turn' ? 'Algorithmus' : 'Zuschauer';
             
             const bots = currentRoom.players.filter(p => p.role === actingRole && p.isBot);
             if(bots.length > 0) {
                  const eventType = currentRoom.turn.replace('_turn', '_action');
                  
                  bots.forEach(botPlayer => {
                      let payload = {};
                      
                      if (actingRole === 'Journalist') {
                          // Has not posted yet
                          if(!currentRoom.roundInfo.journalistPosts.find(post => post.authorId === botPlayer.id)) {
                             payload.text = currentRoom.roundInfo.topicObj.botHeadline;
                              handleAction(null, { room: room.id, type: eventType, payload, isBotSrc: true, botId: botPlayer.id });
                          }
                      } else if (actingRole === 'Algorithmus') {
                          if (currentRoom.roundInfo.algoVotes[botPlayer.id] === undefined) {
                              payload.index = Math.floor(Math.random() * currentRoom.roundInfo.journalistPosts.length);
                              handleAction(null, { room: room.id, type: eventType, payload, isBotSrc: true, botId: botPlayer.id });
                          }
                      } else if (actingRole === 'Zuschauer') {
                          if (currentRoom.roundInfo.zuschauerVotes[botPlayer.id] === undefined) {
                              const p = Math.random();
                              if (p > 0.4 && currentRoom.roundInfo.algoChoice !== null) {
                                  payload.index = currentRoom.roundInfo.algoChoice;
                              } else {
                                  payload.index = Math.floor(Math.random() * currentRoom.roundInfo.journalistPosts.length);
                              }
                              handleAction(null, { room: room.id, type: eventType, payload, isBotSrc: true, botId: botPlayer.id });
                          }
                      }
                  });
             }
         }, 2500);
      }
    }

    socket.on('disconnect', () => {
      const roomId = playerSockets.get(socket.id);
      if(roomId) {
        const room = rooms.get(roomId);
        if(room) {
          room.players = room.players.filter(p => p.id !== socket.id);
          
          if(room.players.length === 0) {
            rooms.delete(roomId);
          } else {
            if(room.host === socket.id) {
              room.host = room.players[0].id; // Assign new host
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
