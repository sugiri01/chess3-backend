const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); // Import cors
const bcrypt = require('bcrypt');
const { pool, redis, initDb } = require('./db');

const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json());

const io = socketIO(server, {
  cors: {
    origin: "*", // Allow all origins for Socket.IO too
    methods: ["GET", "POST"]
  }
});


const PORT = 3000;

// Email Configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// HTML Email Template Builder
const getHtmlTemplate = (title, bodyContent) => `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: 'Georgia', serif; background-color: #1a0a0a; color: #F5F5DC; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; background-color: #2a1515; border: 1px solid #D4AF37; border-radius: 10px; overflow: hidden; }
  .header { background-color: #1a0a0a; padding: 20px; text-align: center; border-bottom: 2px solid #D4AF37; }
  .header h1 { color: #D4AF37; margin: 0; font-size: 24px; letter-spacing: 2px; }
  .content { padding: 30px; line-height: 1.6; color: #F5F5DC; }
  .otp { background-color: #D4AF37; color: #1a0a0a; font-size: 24px; font-weight: bold; padding: 10px 20px; border-radius: 5px; display: inline-block; margin: 20px 0; letter-spacing: 5px; }
  .footer { background-color: #1a0a0a; padding: 15px; text-align: center; font-size: 12px; color: #888; border-top: 1px solid #333; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>GTP CLUB CHESS</h1>
    </div>
    <div class="content">
      <h2>${title}</h2>
      ${bodyContent}
    </div>
    <div class="footer">
      &copy; 2025 GTP Club Chess. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

// Helper to send email
const sendEmail = async (to, subject, htmlContent) => {
  if (!process.env.EMAIL_USER || process.env.EMAIL_PASS === 'YOUR_APP_PASSWORD_HERE') {
    console.log(`[Mock Email] To: ${to}, Subject: ${subject}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: '"GTP Club Chess" <ramak092@gmail.com>', // Sender Name
      to,
      subject,
      html: htmlContent
    });
    console.log(`Email sent to ${to}`);
  } catch (error) {
    console.error('Email send failed:', error);
  }
};

// --- REST Endpoints for Features ---

// 1. User Register (New)
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;

  if (!username || !password || !email) {
    return res.status(400).json({ success: false, message: 'All fields required' });
  }

  try {
    const existing = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Username or Email already exists' });
    }

    const id = uuidv4();
    const hashed = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      'INSERT INTO users (id, username, email, password_hash, wallet_balance) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, username, email, hashed, 0.00]
    );

    const user = newUser.rows[0];
    delete user.password_hash;

    // Send Welcome Email
    const html = getHtmlTemplate('Welcome Aboard!', `
      <p>Dear <strong>${username}</strong>,</p>
      <p>Welcome to the most prestigious chess club. Your account has been successfully created.</p>
      <p>Get ready to challenge grandmasters and climb the ranks.</p>
      <p><em>Good luck and good game!</em></p>
    `);
    await sendEmail(email, 'Welcome to GTP Club Chess', html);

    res.json({ success: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 2. User Login (Updated: No Auto-Register)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = existing.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }

    delete user.password_hash;
    res.json({ success: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 3. Forgot Password (OTP)
app.post('/api/forgot-password', async (req, res) => {
  const { username, email } = req.body; // Allow finding by either
  try {
    let query = 'SELECT * FROM users WHERE username = $1';
    let params = [username];

    if (email) {
      query = 'SELECT * FROM users WHERE email = $1';
      params = [email];
    }

    const userRes = await pool.query(query, params);
    if (userRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }
    const user = userRes.rows[0];

    // Generate 6 Digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60000); // 10 mins

    // Remove old tokens
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    // Store new token
    await pool.query(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
      [uuidv4(), user.id, otp, expiresAt]
    );

    // Send Email (Use user.email from DB)
    if (user.email) {
      const html = getHtmlTemplate('Password Reset Request', `
        <p>Dear ${user.username},</p>
        <p>You requested a password reset. Use the One-Time Password (OTP) below to complete the process:</p>
        <center><div class="otp">${otp}</div></center>
        <p>This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>
      `);
      await sendEmail(user.email, 'Password Reset OTP - GTP Club Chess', html);
      res.json({ success: true, message: 'OTP sent to registered email' });
    } else {
      // Allow fallback for older accounts without email? Or force them to contact support.
      // For now, return OTP in response for testing/legacy support if dev mode
      res.json({ success: true, message: 'OTP Generated (Check Console)', debugOtp: otp });
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 4. Reset Password
app.post('/api/reset-password', async (req, res) => {
  const { username, otp, newPassword } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) return res.status(400).json({ success: false, message: 'User not found' });
    const user = userRes.rows[0];

    const tokenRes = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE user_id = $1 AND token = $2 AND used = FALSE AND expires_at > NOW()',
      [user.id, otp]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or Expired OTP' });
    }

    // Update Password
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, user.id]);

    // Mark Token Used
    await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [tokenRes.rows[0].id]);

    res.json({ success: true, message: 'Password reset successful' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper handleGameOver updated for DB persistence and usernames
async function handleGameOver(match) {
  if (!match.result || match.result.winner === 'draw') {
    // Refund on draw
    if (match.result.reason === 'draw') {
      const fee = match.entryFee || 10.0; // Default 10 if missing
      if (match.whiteDbId) {
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [fee, match.whiteDbId]);
        await pool.query('INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
          [uuidv4(), match.whiteDbId, fee, 'refund', `Refund: Draw in match ${match.matchId}`]);
        await pool.query('UPDATE users SET draws = draws + 1 WHERE id = $1', [match.whiteDbId]);
      }
      if (match.blackDbId) {
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [fee, match.blackDbId]);
        await pool.query('INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
          [uuidv4(), match.blackDbId, fee, 'refund', `Refund: Draw in match ${match.matchId}`]);
        await pool.query('UPDATE users SET draws = draws + 1 WHERE id = $1', [match.blackDbId]);
      }

      // Update Match DB
      await pool.query('UPDATE matches SET ended_at = NOW(), result_reason = $1 WHERE id = $2', ['draw', match.matchId]);
    }
    return;
  }

  // Determine Winner/Loser
  const winnerId = match.result.winner === 'white' ? match.whiteDbId : match.blackDbId;
  const loserId = match.result.winner === 'white' ? match.blackDbId : match.whiteDbId;

  const entryFee = match.entryFee !== undefined ? match.entryFee : 10.0;

  // Update Stats
  await pool.query('UPDATE users SET wins = wins + 1, rating = rating + 10 WHERE id = $1', [winnerId]);
  await pool.query('UPDATE users SET losses = losses + 1, rating = GREATEST(0, rating - 10) WHERE id = $1', [loserId]);

  // Financials:
  // 1. Winner gets their Entry Fee back (Refund).
  // 2. Winner gets 70% of Opponent's Fee (Winnings).
  // 3. Company gets 30% of Opponent's Fee.

  const winnings = entryFee * 0.70;
  const companyCut = entryFee * 0.30;

  // Total added to wallet = EntryFee (Refund) + Winnings
  const totalReturn = entryFee + winnings;

  // Update Match DB
  await pool.query('UPDATE matches SET ended_at = NOW(), winner_id = $1, result_reason = $2 WHERE id = $3',
    [winnerId, match.result.reason, match.matchId]);

  // Update Winner Wallet (Single Update for consistency)
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [totalReturn, winnerId]);

  // LOG TRANSACTIONS
  // Combined Winnings (Entry Fee Refund + Profit)
  await pool.query('INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
    [uuidv4(), winnerId, totalReturn, 'winnings', `Won match ${match.matchId}`]);

  // Record Company Earning
  await pool.query('INSERT INTO company_earnings (id, match_id, amount, description) VALUES ($1, $2, $3, $4)',
    [uuidv4(), match.matchId, companyCut, `30% cut from match ${match.matchId}`]);

  console.log(`Match ${match.matchId} End: Winner ${winnerId} (+${winnings}), Company (+${companyCut})`);

  // Send game_over with winnings info
  const winnerPlayerId = match.players[match.result.winner === 'white' ? 'white' : 'black'];
  const loserPlayerId = match.players[match.result.winner === 'white' ? 'black' : 'white'];

  const winnerPlayer = Array.from(players.values()).find(p => p.playerId === winnerPlayerId);
  const loserPlayer = Array.from(players.values()).find(p => p.playerId === loserPlayerId);

  if (winnerPlayer) {
    io.to(winnerPlayer.socketId).emit('game_over', {
      ...match.result,
      winnings: winnings,
      totalReturn: totalReturn,
      message: `You Won! +₹${winnings.toFixed(2)}`
    });
  }
  if (loserPlayer) {
    io.to(loserPlayer.socketId).emit('game_over', {
      ...match.result,
      winnings: 0,
      message: 'Better luck next time! Keep learning!'
    });
  }
}



// 2. Wallet: Get Balance & Transactions
app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.params.userId]);
    const transactionsRes = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);

    if (userRes.rows.length === 0) return res.status(404).json({ success: false });

    res.json({
      success: true,
      balance: parseFloat(userRes.rows[0].wallet_balance),
      transactions: transactionsRes.rows
    });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// 5. User Stats
app.get('/api/user/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRes = await pool.query('SELECT username, rating, wins, losses, draws, wallet_balance, created_at FROM users WHERE id = $1', [userId]);

    if (userRes.rows.length === 0) return res.status(404).json({ success: false });

    const user = userRes.rows[0];
    const totalGames = user.wins + user.losses + user.draws;
    const winRate = totalGames > 0 ? ((user.wins / totalGames) * 100).toFixed(1) : '0.0';

    // Mock data for static sections for now (table driven approach prepared)
    const stats = {
      ...user,
      totalGames,
      winRate: `${winRate}%`,
      achievements: [
        { title: 'First Win', icon: 'trophy', unlocked: user.wins > 0 },
        { title: 'Participant', icon: 'medal', unlocked: totalGames > 0 },
        { title: 'Pro Player', icon: 'star', unlocked: user.rating > 1500 }
      ],
      paymentMethods: [
        { type: 'UPI', ending: '**56', isDefault: true }
      ]
    };

    res.json({ success: true, stats });
  } catch (e) {
    console.error('Stats API Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 6. User Matches History
app.get('/api/user/:userId/matches', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT 
        m.id, m.result_reason, m.entry_fee, m.created_at, m.ended_at, m.winner_id,
        w.username as white_username, b.username as black_username,
        m.white_player_id, m.black_player_id
      FROM matches m
      LEFT JOIN users w ON m.white_player_id = w.id
      LEFT JOIN users b ON m.black_player_id = b.id
      WHERE m.white_player_id = $1 OR m.black_player_id = $1
      ORDER BY m.created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    res.json({ success: true, matches: result.rows });
  } catch (e) {
    console.error('Matches History Error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Wallet: Add Cash (Simulation)
app.post('/api/wallet/add', async (req, res) => {
  const { userId, amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO transactions (id, user_id, type, amount, status) VALUES ($1, $2, $3, $4, $5)',
      [uuidv4(), userId, 'deposit', amount, 'completed']
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Cash added' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: e.message });
  } finally {
    client.release();
  }
});

// 3. Support: Create Ticket
app.post('/api/support/ticket', async (req, res) => {
  const { userId, subject, message } = req.body;
  try {
    await pool.query(
      'INSERT INTO support_tickets (id, user_id, subject, message) VALUES ($1, $2, $3, $4)',
      [uuidv4(), userId, subject, message]
    );
    res.json({ success: true, message: 'Ticket created' });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// 6. Game History
app.get('/api/user/:userId/matches', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT 
        m.id, m.entry_fee, m.result_reason, m.created_at, m.winner_id,
        u1.username as white_username, 
        u2.username as black_username
      FROM matches m
      LEFT JOIN users u1 ON m.white_player_id = u1.id
      LEFT JOIN users u2 ON m.black_player_id = u2.id
      WHERE m.white_player_id = $1 OR m.black_player_id = $1
      ORDER BY m.created_at DESC
      LIMIT 50
    `;
    const result = await pool.query(query, [userId]);
    res.json({ success: true, matches: result.rows });
  } catch (e) {
    console.error('History API Error:', e);
    res.status(500).json({ success: false });
  }
});

// 4. Referrals
app.get('/api/referrals/:userId', async (req, res) => {
  try {
    const refs = await pool.query('SELECT * FROM referrals WHERE referrer_id = $1', [req.params.userId]);
    res.json({ success: true, count: refs.rows.length, referrals: refs.rows });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// --- KYC Feature ---
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads/kyc');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  }
});

// A. Check KYC Status
app.get('/api/kyc/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query('SELECT * FROM users_kyc WHERE user_id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.json({ success: true, status: 'not_submitted' });
    }

    res.json({ success: true, status: result.rows[0].status, details: result.rows[0] });
  } catch (e) {
    console.error('KYC Status Error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// B. Submit KYC
app.post('/api/kyc/submit', upload.fields([{ name: 'idProof', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]), async (req, res) => {
  try {
    const { userId, fullName, panNumber } = req.body;

    if (!req.files || !req.files.idProof || !req.files.selfie) {
      return res.status(400).json({ success: false, message: 'Both ID Proof and Selfie are required' });
    }

    const idProofPath = '/uploads/kyc/' + req.files.idProof[0].filename;
    const selfiePath = '/uploads/kyc/' + req.files.selfie[0].filename;

    // specific status 'pending'
    const query = `
      INSERT INTO users_kyc (id, user_id, full_name, pan_number, id_proof_url, selfie_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        full_name = EXCLUDED.full_name,
        pan_number = EXCLUDED.pan_number,
        id_proof_url = EXCLUDED.id_proof_url,
        selfie_url = EXCLUDED.selfie_url,
        status = 'pending',
        submitted_at = CURRENT_TIMESTAMP
    `;

    await pool.query(query, [uuidv4(), userId, fullName, panNumber, idProofPath, selfiePath]);

    res.json({ success: true, message: 'KYC Submitted Successfully' });
  } catch (e) {
    console.error('KYC Submit Error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Socket.IO Game Logic ---

const matches = new Map();
const players = new Map(); // socketId -> Player
// Queues per game mode: 'BULLET', 'BLITZ', 'RAPID', etc.
const queues = {
  'BULLET': [],
  'BLITZ': [],
  'RAPID': [],
  'CLASSICAL': [],
  'TOURNAMENT': []
};

class Player {
  constructor(playerId, socketId, dbId = null, username = 'Guest') {
    this.playerId = playerId;
    this.socketId = socketId;
    this.dbId = dbId;
    this.username = username;
    this.color = null;
    this.currentGameId = null;
  }
}

class Match {
  constructor(matchId, whitePlayerId, blackPlayerId, whiteDbId, blackDbId, gameMode, entryFee) {
    this.matchId = matchId;
    this.players = { white: whitePlayerId, black: blackPlayerId };
    this.whiteDbId = whiteDbId;
    this.blackDbId = blackDbId;
    this.gameMode = gameMode;
    this.entryFee = entryFee; // Stored here for game over calculation

    this.chess = new Chess();
    this.fen = this.chess.fen();
    this.turn = 'white';
    this.status = 'active';

    // Time controls (in ms)
    let timeMs = 60000; // Default Bullet
    if (gameMode === 'BLITZ') timeMs = 180000;
    else if (gameMode === 'RAPID') timeMs = 300000;
    else if (gameMode === 'CLASSICAL') timeMs = 600000;

    this.clock = { whiteMs: timeMs, blackMs: timeMs, lastMoveTs: Date.now() };
    this.result = null;
  }

  updateClock() {
    const now = Date.now();
    const elapsed = now - this.clock.lastMoveTs;
    // Only deduct time if game is active and not just starting
    if (this.turn === 'white') this.clock.whiteMs = Math.max(0, this.clock.whiteMs - elapsed);
    else this.clock.blackMs = Math.max(0, this.clock.blackMs - elapsed);
    this.clock.lastMoveTs = now;

    if (this.clock.whiteMs === 0) {
      this.status = 'finished';
      this.result = { winner: 'black', reason: 'timeout' };
      return true;
    }
    if (this.clock.blackMs === 0) {
      this.status = 'finished';
      this.result = { winner: 'white', reason: 'timeout' };
      return true;
    }
    return false;
  }

  makeMove(from, to, promotion) {
    const move = this.chess.move({ from, to, promotion });
    if (!move) return { success: false, reason: 'Invalid move' };
    this.fen = this.chess.fen();
    this.turn = this.chess.turn() === 'w' ? 'white' : 'black';
    this.updateClock();

    if (this.chess.isCheckmate()) {
      this.result = { winner: this.chess.turn() === 'w' ? 'black' : 'white', reason: 'checkmate' };
      this.status = 'finished';
    } else if (this.chess.isDraw()) {
      this.result = { winner: 'draw', reason: 'draw' };
      this.status = 'finished';
    }
    return { success: true };
  }
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // 1. REGISTER PLAYER
  socket.on('register_player', (userId) => {
    // Cleanup old sockets for this user to prevent "Ghost" sessions
    for (const [sId, p] of players.entries()) {
      if (p.dbId === userId && sId !== socket.id) {
        console.log(`[Cleanup] Duplicate login for ${userId}. Disconnecting old socket ${sId}.`);

        // Remove from any queue they might be in
        for (const mode in queues) {
          const qIdx = queues[mode].indexOf(p.playerId);
          if (qIdx > -1) {
            queues[mode].splice(qIdx, 1);
            console.log(`[Cleanup] Removed ${userId} from ${mode} queue.`);
          }
        }
        players.delete(sId);
        io.to(sId).emit('force_disconnect'); // Tell client to stop
      }
    }

    const player = new Player(uuidv4(), socket.id, userId);
    players.set(socket.id, player);
    console.log(`Registered ${socket.id} to user ${userId}`);
  });

  // 2. JOIN QUEUE
  socket.on('join_queue', async (data) => {
    // Data: { userId, gameMode, entryFee, username }
    if (!players.has(socket.id)) {
      // Auto-register if not done (Anonymous fallback)
      players.set(socket.id, new Player(uuidv4(), socket.id, data.userId, data.username));
    }

    const player = players.get(socket.id);
    const mode = data.gameMode || 'BULLET';
    const fee = parseFloat(data.entryFee) || 10.0;

    // VALIDATION: Check Wallet Balance First!
    if (player.dbId) {
      try {
        const res = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [player.dbId]);
        if (res.rows.length > 0) {
          const balance = parseFloat(res.rows[0].wallet_balance);
          if (balance < fee) {
            socket.emit('error_message', { message: `Insufficient Balance! Need ₹${fee}, Have ₹${balance}` });
            return;
          }
        }
      } catch (err) {
        console.error('Balance check failed:', err);
      }
    }

    // CHECK IF ALREADY IN QUEUE (Any Mode)
    let alreadyQueued = false;
    for (const m in queues) {
      if (queues[m].includes(player.playerId)) {
        console.log(`Player ${player.playerId} already in ${m} queue. Moving to new if different.`);
        // Optional: Remove from old queue? For now, we restrict 1 queue at a time.
        const idx = queues[m].indexOf(player.playerId);
        queues[m].splice(idx, 1);
      }
    }

    // Add to specific mode queue
    if (!queues[mode]) queues[mode] = [];
    queues[mode].push(player.playerId);
    player.gameMode = mode; // Track intended mode
    player.entryFee = fee;

    console.log(`Player ${player.dbId} joined ${mode} queue. Size: ${queues[mode].length}`);

    // Attempt Matchmaking for this mode
    if (queues[mode].length >= 2) {
      matchPlayers(mode, fee);
    }
  });

  socket.on('make_move', async (data) => {
    const { matchId, from, to, promotion } = data;
    const match = matches.get(matchId);
    if (!match) return;

    const result = match.makeMove(from, to, promotion);
    if (!result.success) {
      socket.emit('illegal_move', { reason: result.reason });
      return;
    }

    const moveResult = {
      fen: match.fen,
      turn: match.turn,
      clock: { whiteMs: match.clock.whiteMs, blackMs: match.clock.blackMs },
      move: { from, to, promotion } // Echo move for animation
    };

    const whitePlayer = Array.from(players.values()).find(p => p.playerId === match.players.white);
    const blackPlayer = Array.from(players.values()).find(p => p.playerId === match.players.black);

    if (whitePlayer) io.to(whitePlayer.socketId).emit('move_result', moveResult);
    if (blackPlayer) io.to(blackPlayer.socketId).emit('move_result', moveResult);

    if (match.status === 'finished') {
      await handleGameOver(match);
      matches.delete(matchId);
    }
  });

  socket.on('disconnect', () => {
    if (players.has(socket.id)) {
      const player = players.get(socket.id);
      console.log(`Socket disconnected: ${player.playerId} (${player.dbId})`);

      // Remove from all queues
      for (const mode in queues) {
        const idx = queues[mode].indexOf(player.playerId);
        if (idx > -1) {
          queues[mode].splice(idx, 1);
          console.log(`Removed ${player.playerId} from ${mode} queue.`);
        }
      }
      players.delete(socket.id);
    }
  });
});

async function matchPlayers(mode, fee) {
  const q = queues[mode];
  if (q.length < 2) return;

  const p1Id = q[0];
  const p2Id = q[1];

  // Resolve player objects
  const p1 = Array.from(players.values()).find(p => p.playerId === p1Id);
  const p2 = Array.from(players.values()).find(p => p.playerId === p2Id);

  // Stale check
  if (!p1 || !p1.socketId) { q.shift(); return matchPlayers(mode, fee); }
  if (!p2 || !p2.socketId) { q.splice(1, 1); return matchPlayers(mode, fee); }

  // Prevent self-match (if same user logged in twice incredibly fast)
  if (p1.dbId && p2.dbId && p1.dbId === p2.dbId) {
    console.log('Prevented self-match. Removing duplicate.');
    q.splice(1, 1);
    return matchPlayers(mode, fee);
  }

  // Remove both from queue
  q.shift();
  q.shift();

  try {
    // Database Deductions
    console.log(`Starting ${mode} match. Deducting ₹${fee} from ${p1.dbId} and ${p2.dbId}`);

    if (p1.dbId) await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [fee, p1.dbId]);
    if (p2.dbId) await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [fee, p2.dbId]);

    // Log Entry Fee Transactions
    if (p1.dbId) {
      await pool.query('INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [uuidv4(), p1.dbId, fee, 'entry_fee', `Entry Fee: ${mode}`]);
    }
    if (p2.dbId) {
      await pool.query('INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
        [uuidv4(), p2.dbId, fee, 'entry_fee', `Entry Fee: ${mode}`]);
    }

    const isP1White = Math.random() < 0.5;
    const matchId = uuidv4();
    const whiteDbId = isP1White ? p1.dbId : p2.dbId;
    const blackDbId = isP1White ? p2.dbId : p1.dbId;

    const match = new Match(matchId, isP1White ? p1Id : p2Id, isP1White ? p2Id : p1Id, whiteDbId, blackDbId, mode, fee);

    // Save to DB
    await pool.query(
      'INSERT INTO matches (id, white_player_id, black_player_id, entry_fee, stake_amount) VALUES ($1, $2, $3, $4, $5)',
      [matchId, whiteDbId, blackDbId, fee, fee]
    );

    matches.set(matchId, match);

    p1.color = isP1White ? 'white' : 'black';
    p2.color = isP1White ? 'black' : 'white';

    // Broadcast Start
    io.to(p1.socketId).emit('match_found', { matchId, color: p1.color, initialFen: match.fen, clock: match.clock, opponent: p2.username });
    io.to(p2.socketId).emit('match_found', { matchId, color: p2.color, initialFen: match.fen, clock: match.clock, opponent: p1.username });

    console.log(`Match ${matchId} started.`);

  } catch (e) {
    console.error('Match creation failed:', e);
    // Ideally refund if one failed
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', players: players.size, matches: matches.size, queues }));

const startServer = async () => {
  await initDb();
  server.listen(PORT, () => {
    console.log(`Chess server (Multi-Queue) running on port ${PORT}`);
  });
};

startServer();
