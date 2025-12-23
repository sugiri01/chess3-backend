# Chess Multiplayer Server

Node.js server implementing server-authoritative multiplayer chess.

## Tech Stack

- **Express**: HTTP server
- **Socket.IO**: WebSocket real-time communication
- **chess.js**: Chess rules engine and move validation
- **uuid**: Unique ID generation

## Installation

```bash
npm install
```

## Running

### Development (with auto-reload)
```bash
npm run dev
```

### Production
```bash
npm start
```

Server runs on port 3000 (configurable via PORT env variable).

## Architecture

### Core Components

1. **Player Management**
   - Each socket connection = one player
   - Players stored in memory
   - Automatic cleanup on disconnect

2. **Match Management**
   - Matches stored in memory
   - Each match has chess.js instance
   - Server maintains authoritative game state

3. **Matchmaking**
   - Simple FIFO queue
   - Random color assignment
   - Instant matching when 2+ players

4. **Game Logic**
   - All validation server-side
   - chess.js enforces legal moves
   - Server-side clock management

## API Endpoints

### HTTP

#### `GET /health`
Health check endpoint

Response:
```json
{
  "status": "ok",
  "matches": 0,
  "players": 2,
  "queue": 1
}
```

### Socket.IO Events

See main README.md for full event documentation.

## Data Models

### Player
```javascript
{
  playerId: "uuid",
  socketId: "socket-id",
  color: "white" | "black" | null
}
```

### Match
```javascript
{
  matchId: "uuid",
  players: {
    white: "player-id",
    black: "player-id"
  },
  chess: Chess, // chess.js instance
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "white" | "black",
  status: "waiting" | "active" | "finished",
  clock: {
    whiteMs: 300000,
    blackMs: 300000,
    lastMoveTs: 1234567890
  },
  result: {
    winner: "white" | "black" | "draw",
    reason: "checkmate" | "resign" | "timeout" | "draw"
  } | null
}
```

## Clock Management

Clock runs on server time only:

```javascript
updateClock() {
  const now = Date.now();
  const elapsed = now - this.clock.lastMoveTs;
  
  if (this.turn === 'white') {
    this.clock.whiteMs -= elapsed;
  } else {
    this.clock.blackMs -= elapsed;
  }
  
  this.clock.lastMoveTs = now;
  
  // Check timeout
  if (this.clock.whiteMs <= 0) {
    this.result = { winner: 'black', reason: 'timeout' };
    this.status = 'finished';
  }
}
```

## Move Validation Flow

```
1. Receive make_move event
2. Check match exists
3. Check player belongs to match
4. Check correct turn
5. Validate with chess.js
6. Update game state
7. Update clock
8. Check game over conditions
9. Broadcast to both players
```

## Game Over Detection

Server detects:
- Checkmate (chess.js)
- Stalemate (chess.js)
- Draw by repetition (chess.js)
- Draw by insufficient material (chess.js)
- Timeout (server clock)
- Resignation (player request)
- Disconnect (automatic forfeit)

## Security

### What's Implemented
- ✅ Server-side move validation
- ✅ Turn enforcement
- ✅ Player authentication per match
- ✅ No client trust
- ✅ Server-authoritative clock

### What's NOT Implemented (Add for Production)
- ❌ User authentication
- ❌ Rate limiting
- ❌ Input sanitization
- ❌ SQL injection protection (no DB yet)
- ❌ DDoS protection
- ❌ Request validation schemas

## Deployment

### Environment Variables

```bash
PORT=3000  # Server port
```

### Heroku

```bash
heroku create your-chess-server
git push heroku main
```

### Docker

```dockerfile
FROM node:16
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### PM2 (Process Manager)

```bash
npm install -g pm2
pm2 start server.js --name chess-server
pm2 save
pm2 startup
```

## Scaling

### Current Limitations (MVP)
- Single server instance
- In-memory storage (no persistence)
- No horizontal scaling

### Phase 2: Production Scaling

1. **Add Redis**
   - Store matches in Redis
   - Session persistence
   - Pub/Sub for multi-server

2. **Socket.IO Redis Adapter**
   - Enable multi-server Socket.IO
   - Load balancing
   - Sticky sessions

3. **PostgreSQL**
   - Match history
   - User accounts
   - Statistics

4. **Load Balancer**
   - Nginx or AWS ALB
   - Multiple Node instances
   - Health checks

## Monitoring

### Logs to Watch

```bash
# Connection logs
Client connected: <socket-id>
Client disconnected: <socket-id>

# Matchmaking logs
Player <socket-id> joining queue
Match created: <match-id>

# Game logs
Move attempt: <socket-id> from e2 to e4
Illegal move: Not your turn
Game over: checkmate
```

### Metrics to Track (Add Later)

- Active connections
- Matches per minute
- Average game duration
- Move latency
- Error rates

## Testing

### Manual Testing

```bash
# Start server
npm start

# In browser console
const socket = io('http://localhost:3000');
socket.on('connect', () => console.log('Connected'));
socket.emit('join_queue', {});
```

### Automated Testing (Add Later)

```javascript
// Example with socket.io-client
const io = require('socket.io-client');

describe('Matchmaking', () => {
  it('should match two players', (done) => {
    const player1 = io('http://localhost:3000');
    const player2 = io('http://localhost:3000');
    
    player1.emit('join_queue', {});
    player2.emit('join_queue', {});
    
    player1.on('match_found', (data) => {
      expect(data.matchId).toBeDefined();
      done();
    });
  });
});
```

## Known Limitations

1. **No Persistence**: Games lost on server restart
2. **No Authentication**: Anyone can join
3. **No Rate Limiting**: Vulnerable to spam
4. **Single Instance**: No horizontal scaling
5. **No Logging**: No structured logs
6. **No Monitoring**: No metrics collection

These are acceptable for MVP. Address in Phase 2.

## Contributing

See main README.md

## License

MIT
